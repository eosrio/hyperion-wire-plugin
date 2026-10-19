import {ScalarType, type DescField, type DescMessage, type FileRegistry} from '@bufbuild/protobuf';
import {TextDecoder} from 'node:util';
import {BinaryReader, CODEC_LIMITS} from './binary.js';
import {codecAssert, WireCodecError} from './errors.js';

interface FieldModel {
  repeated: boolean;
  scalar?: ScalarType;
  message?: DescMessage;
  delimited?: boolean;
  map?: Map<number, FieldModel>;
}
interface Tracker {
  counts: Map<number, number>;
  children: Map<number, Tracker>;
  anyTypeUrl?: string;
  anyBytes?: Uint8Array;
}
const tracker = (): Tracker => ({counts: new Map(), children: new Map()});
const fieldModels = new WeakMap<DescMessage, Map<number, FieldModel>>();
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

function model(field: DescField): FieldModel {
  switch (field.fieldKind) {
    case 'scalar': return {repeated: false, scalar: field.scalar};
    case 'enum': return {repeated: false, scalar: ScalarType.INT32};
    case 'message': return {repeated: false, message: field.message, delimited: field.delimitedEncoding};
    case 'list': return field.listKind === 'message'
      ? {repeated: true, message: field.message, delimited: field.delimitedEncoding}
      : {repeated: true, scalar: field.listKind === 'enum' ? ScalarType.INT32 : field.scalar};
    case 'map': {
      const value: FieldModel = field.mapKind === 'message' ? {repeated: false, message: field.message}
        : {repeated: false, scalar: field.mapKind === 'enum' ? ScalarType.INT32 : field.scalar};
      return {repeated: true, map: new Map([[1, {repeated: false, scalar: field.mapKey}], [2, value]])};
    }
  }
}

function models(message: DescMessage): Map<number, FieldModel> {
  let result = fieldModels.get(message);
  if (!result) {result = new Map(message.fields.map(field => [field.number, model(field)])); fieldModels.set(message, result); }
  return result;
}

function varint(reader: BinaryReader): bigint {
  let value = 0n;
  for (let index = 0; index < 10; index++) {
    const byte = reader.u8();
    codecAssert(index < 9 || byte <= 1, 'Protobuf varint overflow');
    value |= BigInt(byte & 127) << BigInt(index * 7);
    if (byte < 128) return value;
  }
  throw new WireCodecError('invalid_value', 'Unterminated protobuf varint');
}

function length(reader: BinaryReader): number {
  const value = varint(reader);
  codecAssert(value <= 0xffff_ffffn, 'Protobuf length overflow');
  return Number(value);
}

function wireType(scalar: ScalarType): number {
  if (scalar === ScalarType.DOUBLE || scalar === ScalarType.FIXED64 || scalar === ScalarType.SFIXED64) return 1;
  if (scalar === ScalarType.FLOAT || scalar === ScalarType.FIXED32 || scalar === ScalarType.SFIXED32) return 5;
  if (scalar === ScalarType.STRING || scalar === ScalarType.BYTES) return 2;
  return 0;
}

/**
 * Count the descriptor-defined allocations before handing bytes to the protobuf
 * implementation. Counting after fromBinary would let a small repeated-empty-
 * message payload allocate millions of JavaScript objects first.
 */
export function preflightProtobuf(message: DescMessage, bytes: Uint8Array, registry: FileRegistry | undefined, initialDepth = 0, budget = {nodes: 0}): void {
  const node = (): void => codecAssert(++budget.nodes <= CODEC_LIMITS.maxNodes, 'Protobuf exceeds node limit', 'limits_exceeded');
  const count = (context: Tracker, field: number, amount = 1): void => {
    const total = (context.counts.get(field) ?? 0) + amount;
    codecAssert(total <= CODEC_LIMITS.maxItems, 'Protobuf repeated field exceeds element limit', 'limits_exceeded');
    context.counts.set(field, total);
  };
  const scalar = (reader: BinaryReader, wire: number): Uint8Array | undefined => {
    if (wire === 0) varint(reader);
    else if (wire === 1) reader.take(8);
    else if (wire === 2) return reader.take(length(reader));
    else if (wire === 5) reader.take(4);
    else throw new WireCodecError('invalid_value', 'Invalid protobuf scalar wire type');
    return undefined;
  };
  function visit(reader: BinaryReader, descriptor: DescMessage | undefined, fields: Map<number, FieldModel> | undefined, context: Tracker, depth: number): void {
    codecAssert(depth <= CODEC_LIMITS.maxDepth, 'Protobuf exceeds recursion limit', 'limits_exceeded');
    while (reader.remaining) {
      const tag = varint(reader);
      codecAssert(tag <= 0xffff_ffffn && tag >= 8n, 'Invalid protobuf field tag');
      const number = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      codecAssert(wire !== 3 && wire !== 4, 'Protobuf group fields are unsupported', 'unsupported_feature');
      codecAssert(wire <= 5, 'Invalid protobuf wire type');
      node();
      const field = fields?.get(number);
      if (!field) {
        count(context, 0);
        scalar(reader, wire);
        continue;
      }
      const packed = field.repeated && field.scalar !== undefined && wire === 2 && wireType(field.scalar) !== 2;
      if (field.repeated && !packed) count(context, number);
      if (field.map || field.message) {
        codecAssert(!field.delimited, 'Protobuf group fields are unsupported', 'unsupported_feature');
        codecAssert(wire === 2, 'Invalid protobuf message wire type');
        let child = field.repeated ? undefined : context.children.get(number);
        if (!child) {child = tracker(); if (!field.repeated) context.children.set(number, child); }
        const childReader = new BinaryReader(reader.take(length(reader)));
        visit(childReader, field.message, field.map ?? (field.message ? models(field.message) : undefined), child, depth + 1);
        childReader.done();
      } else {
        const expected = wireType(field.scalar!);
        if (field.repeated && wire === 2 && expected !== 2) {
          const packed = new BinaryReader(reader.take(length(reader)));
          while (packed.remaining) {scalar(packed, expected); count(context, number); node(); }
        } else {
          codecAssert(wire === expected, 'Invalid protobuf scalar wire type');
          const data = scalar(reader, wire);
          if (descriptor?.typeName === 'google.protobuf.Any' && data) {
            if (number === 1) {
              try {context.anyTypeUrl = decoder.decode(data); }
              catch {throw new WireCodecError('invalid_value', 'Invalid Any type URL UTF-8'); }
            } else if (number === 2) context.anyBytes = data;
          }
        }
      }
    }
    // JSON conversion expands Any.value lazily. Its opaque bytes need the same
    // preflight before toJson can invoke another binary decoder internally.
    if (context.anyTypeUrl && context.anyBytes) {
      const nested = registry?.getMessage(context.anyTypeUrl.slice(context.anyTypeUrl.lastIndexOf('/') + 1));
      if (nested) visit(new BinaryReader(context.anyBytes), nested, models(nested), tracker(), depth + 1);
    }
  }
  visit(new BinaryReader(bytes), message, models(message), tracker(), initialDepth);
}
