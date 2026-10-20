import {resolveCodecProfile, type WireCodecProfile} from '../profiles.js';
import {Buffer} from 'node:buffer';
import {BinaryReader, BinaryWriter, CODEC_LIMITS, fromHex, integer, plainObject, toHex} from './binary.js';
import {codecAssert, WireCodecError} from './errors.js';
import {decodeName, encodeName} from './names.js';

export interface WireTypeDef {new_type_name: string; type: string}
export interface WireFieldDef {name: string; type: string}
export interface WireStructDef {name: string; base: string; fields: WireFieldDef[]}
export interface WireActionDef {name: string; type: string; ricardian_contract: string}
export interface WireIndexDef {name: string; key_type: string; table_id: number}
export interface WireTableDef {name: string; index_type: string; key_names: string[]; key_types: string[]; type: string; table_id: number; secondary_indexes: WireIndexDef[]}
export interface WireEnumDef {name: string; type: string; values: {name: string; value: string}[]}
export interface WireAbi {
  version: string;
  types: WireTypeDef[];
  structs: WireStructDef[];
  actions: WireActionDef[];
  tables: WireTableDef[];
  ricardian_clauses: {id: string; body: string}[];
  error_messages: {error_code: string; error_msg: string}[];
  abi_extensions: [number, string][];
  variants?: {name: string; types: string[]}[];
  action_results?: {name: string; result_type: string}[];
  enums?: WireEnumDef[];
  /** Original binary JSON string, retained without normalization. */
  protobuf_types?: string;
}

const text = (input: unknown): string => {
  codecAssert(typeof input === 'string' && !/[\ud800-\udfff]/u.test(input), 'Expected ABI string', 'invalid_abi');
  return input;
};
const list = <T>(input: unknown, visit: (item: unknown) => T): T[] => {
  codecAssert(Array.isArray(input) && input.length <= 100_000, 'Invalid ABI collection', 'invalid_abi');
  return input.map(visit);
};
const object = (input: unknown, allowed: string[]): Record<string, unknown> => {
  const value = plainObject(input, 'invalid_abi');
  codecAssert(Object.keys(value).every(key => allowed.includes(key)), 'Unknown ABI metadata field', 'unsupported_feature');
  return value;
};
const uint16 = (input: unknown): number => Number(integer(input, 16));

function descriptorJson(value: unknown, depth = 0, state = {nodes: 0, bytes: 0}): unknown {
  codecAssert(depth <= CODEC_LIMITS.maxDepth && ++state.nodes <= CODEC_LIMITS.maxNodes, 'Descriptor JSON exceeds codec limits', 'limits_exceeded');
  if (typeof value === 'string') {state.bytes += Buffer.byteLength(value); codecAssert(state.bytes <= CODEC_LIMITS.maxBytes, 'Descriptor strings exceed codec byte limit', 'limits_exceeded'); return value; }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {codecAssert(Number.isFinite(value), 'Invalid descriptor JSON number', 'invalid_abi'); return value; }
  if (Array.isArray(value)) {codecAssert(value.length <= CODEC_LIMITS.maxItems, 'Descriptor array exceeds codec limits', 'limits_exceeded'); return value.map(item => descriptorJson(item, depth + 1, state)); }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(plainObject(value, 'invalid_abi'))) {state.bytes += Buffer.byteLength(key); codecAssert(state.bytes <= CODEC_LIMITS.maxBytes, 'Descriptor keys exceed codec byte limit', 'limits_exceeded'); result[key] = descriptorJson(entry, depth + 1, state); }
  return result;
}

/** Object descriptors use a shared UTF-8 key order; raw descriptor strings remain byte-exact. */
function descriptorStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(descriptorStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).map(key => ({key, utf8: Buffer.from(key)}))
    .sort((left, right) => Buffer.compare(left.utf8, right.utf8));
  return `{${keys.map(({key}) => `${JSON.stringify(key)}:${descriptorStringify(object[key])}`).join(',')}}`;
}

function parseAbi(input: unknown): WireAbi {
  const value = object(input, ['____comment', 'version', 'types', 'structs', 'actions', 'tables', 'ricardian_clauses', 'error_messages', 'abi_extensions', 'variants', 'action_results', 'enums', 'protobuf_types']);
  const version = text(value.version);
  codecAssert(/^sysio::abi\/1\.[0-3]$/.test(version), 'Unsupported Wire ABI version', 'unsupported_feature');
  const result: WireAbi = {
    version,
    types: list(value.types ?? [], item => { const v = object(item, ['new_type_name', 'type']); return {new_type_name: text(v.new_type_name), type: text(v.type)}; }),
    structs: list(value.structs ?? [], item => {
      const v = object(item, ['name', 'base', 'fields']);
      return {name: text(v.name), base: text(v.base ?? ''), fields: list(v.fields, field => {const f = object(field, ['name', 'type']); return {name: text(f.name), type: text(f.type)}; })};
    }),
    actions: list(value.actions ?? [], item => {const v = object(item, ['name', 'type', 'ricardian_contract']); return {name: text(v.name), type: text(v.type), ricardian_contract: text(v.ricardian_contract ?? '')}; }),
    tables: list(value.tables ?? [], item => {
      const v = object(item, ['name', 'index_type', 'key_names', 'key_types', 'type', 'table_id', 'secondary_indexes']);
      return {name: text(v.name), index_type: text(v.index_type ?? ''), key_names: list(v.key_names ?? [], text), key_types: list(v.key_types ?? [], text), type: text(v.type), table_id: uint16(v.table_id ?? 0), secondary_indexes: list(v.secondary_indexes ?? [], entry => {const i = object(entry, ['name', 'key_type', 'table_id']); return {name: text(i.name), key_type: text(i.key_type), table_id: uint16(i.table_id ?? 0)}; })};
    }),
    ricardian_clauses: list(value.ricardian_clauses ?? [], item => {const v = object(item, ['id', 'body']); return {id: text(v.id), body: text(v.body)}; }),
    error_messages: list(value.error_messages ?? [], item => {const v = object(item, ['error_code', 'error_msg']); return {error_code: integer(v.error_code, 64).toString(), error_msg: text(v.error_msg)}; }),
    abi_extensions: list(value.abi_extensions ?? [], item => {codecAssert(Array.isArray(item) && item.length === 2, 'Invalid ABI extension', 'invalid_abi'); return [uint16(item[0]), toHex(fromHex(item[1]))]; }),
  };
  if (Object.hasOwn(value, 'variants')) result.variants = list(value.variants, item => {const v = object(item, ['name', 'types']); return {name: text(v.name), types: list(v.types, text)}; });
  if (Object.hasOwn(value, 'action_results')) result.action_results = list(value.action_results, item => {const v = object(item, ['name', 'result_type']); return {name: text(v.name), result_type: text(v.result_type)}; });
  if (Object.hasOwn(value, 'enums')) result.enums = list(value.enums, item => {const v = object(item, ['name', 'type', 'values']); return {name: text(v.name), type: text(v.type), values: list(v.values, entry => {const e = object(entry, ['name', 'value']); return {name: text(e.name), value: integer(e.value, 64, true).toString()}; })}; });
  if (Object.hasOwn(value, 'protobuf_types')) {
    const descriptor = value.protobuf_types;
    codecAssert(typeof descriptor === 'string' || (typeof descriptor === 'object' && descriptor !== null && !Array.isArray(descriptor)), 'Invalid protobuf descriptors', 'invalid_abi');
    result.protobuf_types = typeof descriptor === 'string' ? descriptor : descriptorStringify(descriptorJson(descriptor));
    codecAssert(Buffer.byteLength(result.protobuf_types) <= CODEC_LIMITS.maxBytes, 'Protobuf descriptors exceed codec limit', 'limits_exceeded');
    if (result.protobuf_types !== '') {
      try { codecAssert(typeof JSON.parse(result.protobuf_types) === 'object', 'Invalid protobuf descriptor JSON', 'invalid_abi'); }
      catch { throw new WireCodecError('invalid_abi', 'Invalid protobuf descriptor JSON'); }
    }
  }
  return result;
}

/** Snapshot the supported Wire layout. Unknown fields fail explicitly rather than being discarded. */
export function parseWireAbi(input: unknown): WireAbi {
  try { return parseAbi(input); }
  catch (error) {
    if (error instanceof WireCodecError && error.code === 'invalid_value') throw new WireCodecError('invalid_abi', error.message);
    throw error;
  }
}

function checkProfile(profile: WireCodecProfile): void {
  const approved = resolveCodecProfile(profile.id);
  codecAssert(Object.entries(approved).every(([key, value]) => profile[key as keyof WireCodecProfile] === value), 'Unknown Wire revision profile', 'unsupported_feature');
}

export function decodeWireAbi(bytes: Uint8Array, profile: WireCodecProfile = resolveCodecProfile()): WireAbi {
  // Explicit resolution rejects an object that merely resembles an approved revision profile.
  checkProfile(profile);
  try {
    const reader = new BinaryReader(bytes);
    const strings = () => reader.vector(() => reader.text());
    const name = () => decodeName(reader.uint(8));
    const result: WireAbi = {
      version: reader.text(),
      types: reader.vector(() => ({new_type_name: reader.text(), type: reader.text()})),
      structs: reader.vector(() => ({name: reader.text(), base: reader.text(), fields: reader.vector(() => ({name: reader.text(), type: reader.text()}))})),
      actions: reader.vector(() => ({name: name(), type: reader.text(), ricardian_contract: reader.text()})),
      tables: reader.vector(() => ({name: reader.text(), index_type: reader.text(), key_names: strings(), key_types: strings(), type: reader.text(), table_id: Number(reader.uint(2)), secondary_indexes: reader.vector(() => ({name: reader.text(), key_type: reader.text(), table_id: Number(reader.uint(2))}))})),
      ricardian_clauses: reader.vector(() => ({id: reader.text(), body: reader.text()})),
      error_messages: reader.vector(() => ({error_code: reader.uint(8).toString(), error_msg: reader.text()})),
      abi_extensions: reader.vector(() => [Number(reader.uint(2)), toHex(reader.take(reader.varuint()))]),
    };
    if (reader.remaining) result.variants = reader.vector(() => ({name: reader.text(), types: strings()}));
    if (reader.remaining) result.action_results = reader.vector(() => ({name: name(), result_type: reader.text()}));
    if (reader.remaining) result.enums = reader.vector(() => ({name: reader.text(), type: reader.text(), values: reader.vector(() => ({name: reader.text(), value: reader.uint(8, true).toString()}))}));
    if (reader.remaining) result.protobuf_types = reader.text();
    codecAssert(reader.remaining === 0, 'Unsupported trailing Wire ABI metadata', 'unsupported_feature');
    return parseWireAbi(result);
  } catch (error) {
    if (error instanceof WireCodecError && error.code === 'invalid_value') throw new WireCodecError('invalid_abi', error.message);
    throw error;
  }
}

export function encodeWireAbi(input: unknown, profile: WireCodecProfile = resolveCodecProfile()): Uint8Array {
  checkProfile(profile);
  try {
    const abi = parseWireAbi(input);
    const writer = new BinaryWriter();
    const names = (value: string) => writer.uint(encodeName(value), 8);
    const strings = (values: string[]) => writer.vector(values, value => writer.text(value));
    writer.text(abi.version);
    writer.vector(abi.types, item => {const v = item as WireTypeDef; writer.text(v.new_type_name); writer.text(v.type); });
    writer.vector(abi.structs, item => {const v = item as WireStructDef; writer.text(v.name); writer.text(v.base); writer.vector(v.fields, field => {const f = field as WireFieldDef; writer.text(f.name); writer.text(f.type); }); });
    writer.vector(abi.actions, item => {const v = item as WireActionDef; names(v.name); writer.text(v.type); writer.text(v.ricardian_contract); });
    writer.vector(abi.tables, item => {const v = item as WireTableDef; writer.text(v.name); writer.text(v.index_type); strings(v.key_names); strings(v.key_types); writer.text(v.type); writer.uint(v.table_id, 2); writer.vector(v.secondary_indexes, index => {const i = index as WireIndexDef; writer.text(i.name); writer.text(i.key_type); writer.uint(i.table_id, 2); }); });
    writer.vector(abi.ricardian_clauses, item => {const v = item as {id: string; body: string}; writer.text(v.id); writer.text(v.body); });
    writer.vector(abi.error_messages, item => {const v = item as {error_code: string; error_msg: string}; writer.uint(v.error_code, 8); writer.text(v.error_msg); });
    writer.vector(abi.abi_extensions, item => {const [id, hex] = item as [number, string]; writer.uint(id, 2); const bytes = fromHex(hex); writer.varuint(bytes.length); writer.add(bytes); });
    const tail = ['variants', 'action_results', 'enums', 'protobuf_types'] as const;
    let last = -1;
    for (let index = 0; index < tail.length; index++) if (Object.hasOwn(abi, tail[index]!)) last = index;
    if (last >= 0) writer.vector(abi.variants ?? [], item => {const v = item as {name: string; types: string[]}; writer.text(v.name); strings(v.types); });
    if (last >= 1) writer.vector(abi.action_results ?? [], item => {const v = item as {name: string; result_type: string}; names(v.name); writer.text(v.result_type); });
    if (last >= 2) writer.vector(abi.enums ?? [], item => {const v = item as WireEnumDef; writer.text(v.name); writer.text(v.type); writer.vector(v.values, entry => {const e = entry as {name: string; value: string}; writer.text(e.name); writer.uint(e.value, 8, true); }); });
    if (last >= 3) writer.text(abi.protobuf_types ?? '');
    return writer.finish();
  } catch (error) {
    if (error instanceof WireCodecError && error.code === 'invalid_value') throw new WireCodecError('invalid_abi', error.message);
    throw error;
  }
}
