import {createFileRegistry, fromBinary, fromJson, toBinary, toJson, type FileRegistry, type JsonValue} from '@bufbuild/protobuf';
import {Buffer} from 'node:buffer';
import {FileDescriptorSetSchema} from '@bufbuild/protobuf/wkt';
import {decodeWireCrypto, encodeWireCrypto} from '../crypto.js';
import {resolveCodecProfile, type WireCodecProfile} from '../profiles.js';
import {parseWireAbi, type WireAbi, type WireEnumDef, type WireFieldDef} from './abi.js';
import {BinaryReader, BinaryWriter, CODEC_LIMITS, fromHex, integer, plainObject, toHex} from './binary.js';
import {codecAssert, WireCodecError} from './errors.js';
import {decodeName, decodeSlug, encodeName, encodeSlug} from './names.js';
import {preflightProtobuf} from './protobuf-limits.js';

const INTEGER = /^(u?int)(8|16|32|64|128)$/;
const BUILTINS = new Set(['bool', 'varint32', 'varuint32', 'varint_int64', 'varint_uint64', 'float32', 'float64', 'float128', 'time_point', 'time_point_sec', 'block_timestamp_type', 'name', 'bytes', 'string', 'checksum160', 'checksum256', 'checksum512', 'public_key', 'signature', 'symbol', 'symbol_code', 'asset', 'extended_asset', 'bitset']);
const text = (value: unknown): string => {codecAssert(typeof value === 'string', 'Expected a string'); return value; };

function jsonSnapshot(value: unknown, depth = 0, state = {nodes: 0, bytes: 0}): JsonValue {
  codecAssert(depth <= CODEC_LIMITS.maxDepth && ++state.nodes <= CODEC_LIMITS.maxNodes, 'JSON exceeds codec traversal limits', 'limits_exceeded');
  if (typeof value === 'string') {state.bytes += Buffer.byteLength(value); codecAssert(state.bytes <= CODEC_LIMITS.maxBytes, 'JSON strings exceed codec byte limit', 'limits_exceeded'); return value; }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {codecAssert(Number.isFinite(value), 'Invalid JSON number'); return value; }
  if (Array.isArray(value)) {
    codecAssert(value.length <= CODEC_LIMITS.maxItems, 'Array exceeds codec limit', 'limits_exceeded');
    return value.map(item => jsonSnapshot(item, depth + 1, state));
  }
  const object = plainObject(value);
  const result: {[key: string]: JsonValue} = {};
  for (const [key, item] of Object.entries(object)) {
    state.bytes += Buffer.byteLength(key);
    codecAssert(state.bytes <= CODEC_LIMITS.maxBytes, 'JSON keys exceed codec byte limit', 'limits_exceeded');
    Object.defineProperty(result, key, {value: jsonSnapshot(item, depth + 1, state), enumerable: true, writable: true, configurable: true});
  }
  return result;
}

/** Bound the complete value once, before any per-field protobuf parser allocates. */
function checkInputBudget(value: unknown, depth = 0, state = {nodes: 0, bytes: 0}): void {
  codecAssert(depth <= CODEC_LIMITS.maxDepth && ++state.nodes <= CODEC_LIMITS.maxNodes, 'Value JSON exceeds codec traversal limits', 'limits_exceeded');
  if (typeof value === 'string') {state.bytes += Buffer.byteLength(value); codecAssert(state.bytes <= CODEC_LIMITS.maxBytes, 'Value JSON exceeds codec byte limit', 'limits_exceeded'); return; }
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'bigint') return;
  if (typeof value === 'number') {codecAssert(Number.isFinite(value), 'Invalid numeric input'); return; }
  if (Array.isArray(value)) {
    codecAssert(value.length <= CODEC_LIMITS.maxItems, 'Value array exceeds codec limit', 'limits_exceeded');
    for (const item of value) checkInputBudget(item, depth + 1, state);
    return;
  }
  for (const [key, entry] of Object.entries(plainObject(value))) {
    state.bytes += Buffer.byteLength(key);
    codecAssert(state.bytes <= CODEC_LIMITS.maxBytes, 'Value JSON keys exceed codec byte limit', 'limits_exceeded');
    checkInputBudget(entry, depth + 1, state);
  }
}

/** fc prints float values as fixed 17-place strings, including magnitudes beyond JS toFixed's range. */
function formatFloat(bytes: Uint8Array, width: number): string {
  const bits = new BinaryReader(bytes).uint(width);
  const fractionBits = width === 4 ? 23 : 52;
  const exponentBits = width === 4 ? 8 : 11;
  const bias = width === 4 ? 127 : 1023;
  const sign = (bits >> BigInt(width * 8 - 1)) ? '-' : '';
  const exponent = Number((bits >> BigInt(fractionBits)) & ((1n << BigInt(exponentBits)) - 1n));
  const fraction = bits & ((1n << BigInt(fractionBits)) - 1n);
  if (exponent === (1 << exponentBits) - 1) return fraction ? 'nan' : `${sign}inf`;
  const significand = exponent === 0 ? fraction : fraction + (1n << BigInt(fractionBits));
  const power = (exponent === 0 ? 1 - bias : exponent - bias) - fractionBits;
  let numerator = significand * 100_000_000_000_000_000n;
  let denominator = 1n;
  if (power >= 0) numerator <<= BigInt(power); else denominator <<= BigInt(-power);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n !== 0n)) rounded++;
  const digits = rounded.toString().padStart(18, '0');
  return `${sign}${digits.slice(0, -17)}.${digits.slice(-17)}`;
}

function formatTime(milliseconds: number, secondsOnly = false): string {
  const date = new Date(milliseconds);
  codecAssert(Number.isFinite(date.getTime()), 'Timestamp outside supported ISO date range', 'unsupported_feature');
  const iso = date.toISOString();
  codecAssert(/^\d{4}-/.test(iso), 'Timestamp outside four-digit ISO year range', 'unsupported_feature');
  return secondsOnly ? iso.slice(0, 19) : iso.slice(0, -1);
}

function formatNegativeTimePoint(microseconds: bigint): string {
  const absolute = -microseconds;
  const hours = (absolute / 3_600_000_000n).toString().padStart(2, '0');
  const minutes = ((absolute / 60_000_000n) % 60n).toString().padStart(2, '0');
  const seconds = ((absolute / 1_000_000n) % 60n).toString().padStart(2, '0');
  const fraction = absolute % 1_000_000n;
  return `-${hours}${minutes}${seconds}${fraction ? `.${fraction.toString().padStart(6, '0')}` : ''}`;
}

function parseTime(value: unknown, secondsOnly = false): number {
  const input = text(value);
  codecAssert((secondsOnly ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}$/).test(input), 'Expected canonical UTC timestamp without zone');
  const milliseconds = Date.parse(`${input}Z`);
  codecAssert(Number.isFinite(milliseconds) && formatTime(milliseconds, secondsOnly) === input, 'Invalid timestamp');
  return milliseconds;
}

function symbolText(raw: bigint, codeOnly = false): string {
  const precision = codeOnly ? 0 : Number(raw & 255n);
  let code = codeOnly ? raw : raw >> 8n;
  let name = '';
  while (code) {name += String.fromCharCode(Number(code & 255n)); code >>= 8n; }
  codecAssert(precision <= 18 && /^[A-Z]*$/.test(name) && name.length <= 7, 'Invalid binary symbol');
  return codeOnly ? name : `${precision},${name}`;
}

function symbolRaw(value: unknown, codeOnly = false): bigint {
  const input = text(value);
  const match = codeOnly ? /^([A-Z]{0,7})$/.exec(input) : /^(0|[1-9]|1[0-8]),([A-Z]{0,7})$/.exec(input);
  codecAssert(match, 'Invalid symbol');
  const precision = codeOnly ? 0 : Number(match[1]);
  const name = match[codeOnly ? 1 : 2]!;
  let result = BigInt(precision);
  for (let index = 0; index < name.length; index++) result |= BigInt(name.charCodeAt(index)) << BigInt(8 * (index + (codeOnly ? 0 : 1)));
  return result;
}

function parseAsset(value: unknown): {amount: bigint; symbol: bigint} {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))? ([A-Z]{1,7})$/.exec(text(value));
  codecAssert(match, 'Invalid asset string');
  const amount = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`);
  codecAssert(amount >= -(2n ** 62n - 1n) && amount <= 2n ** 62n - 1n, 'Asset amount exceeds Wire range');
  return {amount, symbol: symbolRaw(`${(match[3] ?? '').length},${match[4]}`)};
}

export interface WireValueCodec {
  decode(typeName: string, bytes: Uint8Array): unknown;
  encode(typeName: string, value: unknown): Uint8Array;
}

export function createWireValueCodec(input: unknown, profile: WireCodecProfile = resolveCodecProfile()): WireValueCodec {
  const knownProfile = resolveCodecProfile(profile.id);
  codecAssert(Object.entries(knownProfile).every(([key, value]) => profile[key as keyof WireCodecProfile] === value), 'Unknown Wire revision profile', 'unsupported_feature');
  const abi = parseWireAbi(input);
  const aliases = new Map(abi.types.map(item => [item.new_type_name, item.type]));
  const structs = new Map(abi.structs.map(item => [item.name, item]));
  const variants = new Map((abi.variants ?? []).map(item => [item.name, item.types]));
  const enums = new Map((abi.enums ?? []).map(item => [item.name, item]));
  const builtins = new Set(BUILTINS);
  if (profile.slugNameBuiltin) builtins.add('slug_name');
  let protobuf: FileRegistry | undefined;
  if (abi.protobuf_types) {
    try {
      codecAssert(abi.protobuf_types.length <= CODEC_LIMITS.maxBytes, 'Protobuf descriptors exceed codec limit', 'limits_exceeded');
      const descriptors = fromJson(FileDescriptorSetSchema, jsonSnapshot(JSON.parse(abi.protobuf_types)), {ignoreUnknownFields: true, recursionLimit: CODEC_LIMITS.maxDepth});
      protobuf = createFileRegistry(descriptors);
    } catch (error) {
      if (error instanceof WireCodecError) throw error;
      throw new WireCodecError('invalid_abi', `Invalid protobuf descriptors: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const names = [...aliases.keys(), ...structs.keys(), ...variants.keys(), ...enums.keys()];
  codecAssert(names.length === new Set(names).size && aliases.size === abi.types.length && structs.size === abi.structs.length && variants.size === (abi.variants ?? []).length && enums.size === (abi.enums ?? []).length, 'Duplicate ABI type name', 'invalid_abi');
  // Generated ABIs can retain reflected structs for builtins (for example varint_int64).
  // The node's builtin decoder takes precedence while metadata remains intact.
  codecAssert(names.every(name => name.length > 0) && [...aliases.keys(), ...variants.keys(), ...enums.keys()].every(name => !builtins.has(name) && !INTEGER.test(name)), 'ABI type shadows builtin', 'invalid_abi');
  const resolve = (type: string, visited = new Set<string>()): string => {
    codecAssert(visited.size <= CODEC_LIMITS.maxDepth && !visited.has(type), 'Cyclic ABI alias', 'invalid_abi');
    const target = aliases.get(type);
    if (!target) return type;
    visited.add(type);
    return resolve(target, visited);
  };
  const fieldsCache = new Map<string, WireFieldDef[]>();
  const fieldsFor = (name: string, visited = new Set<string>()): WireFieldDef[] => {
    if (fieldsCache.has(name)) return fieldsCache.get(name)!;
    codecAssert(visited.size < CODEC_LIMITS.maxDepth && !visited.has(name), 'Cyclic ABI inheritance', 'invalid_abi');
    const struct = structs.get(name);
    codecAssert(struct, `Missing ABI struct ${name}`, 'invalid_abi');
    visited.add(name);
    const fields = [...(struct.base ? fieldsFor(resolve(struct.base), visited) : []), ...struct.fields];
    codecAssert(new Set(fields.map(field => field.name)).size === fields.length, 'Duplicate ABI struct field', 'invalid_abi');
    let extensions = false;
    for (const field of fields) {
      extensions ||= field.type.endsWith('$');
      codecAssert(!extensions || field.type.endsWith('$'), 'Binary extensions must be trailing fields', 'invalid_abi');
    }
    fieldsCache.set(name, fields);
    return fields;
  };
  const knownType = (type: string, depth = 0): boolean => {
    codecAssert(typeof type === 'string' && type.length > 0 && type.length <= 1024, 'Invalid ABI type name', 'invalid_abi');
    codecAssert(depth < CODEC_LIMITS.maxDepth, 'Type nesting exceeds codec limit', 'limits_exceeded');
    const resolved = resolve(type);
    const wrapper = /^(.*)(\[\d*\]|\?|\$)$/.exec(resolved);
    if (wrapper) return knownType(wrapper[1]!, depth + 1);
    return INTEGER.test(resolved) || builtins.has(resolved) || structs.has(resolved) || variants.has(resolved) || enums.has(resolved) || (resolved.startsWith('protobuf::') && !!protobuf?.getMessage(resolved.slice(10)));
  };
  for (const type of aliases.values()) codecAssert(knownType(type), `Unknown ABI alias target ${type}`, 'unsupported_feature');
  for (const struct of abi.structs) for (const field of fieldsFor(struct.name)) codecAssert(knownType(field.type), `Unknown ABI field type ${field.type}`, 'unsupported_feature');
  for (const members of variants.values()) codecAssert(members.length > 0 && new Set(members).size === members.length && members.every(member => knownType(member)), 'Invalid ABI variant members', 'invalid_abi');
  for (const definition of enums.values()) {
    const match = INTEGER.exec(definition.type);
    codecAssert(match, 'Enum must use fixed-width integer type', 'invalid_abi');
    codecAssert(new Set(definition.values.map(member => member.name)).size === definition.values.length && new Set(definition.values.map(member => member.value)).size === definition.values.length, 'Duplicate enum member name or value', 'invalid_abi');
    for (const member of definition.values) {
      try { integer(member.value, Number(match[2]), match[1] === 'int'); }
      catch {throw new WireCodecError('invalid_abi', 'Enum member exceeds its underlying integer range'); }
    }
  }
  for (const entry of [...abi.actions.map(item => item.type), ...abi.tables.map(item => item.type), ...(abi.action_results ?? []).map(item => item.result_type)]) codecAssert(knownType(entry), `Unknown ABI root type ${entry}`, 'unsupported_feature');

  function walk(type: string, reader: BinaryReader | undefined, writer: BinaryWriter | undefined, value: unknown, depth: number, state: {nodes: number}, extensionsAllowed: boolean): unknown {
    codecAssert(depth <= CODEC_LIMITS.maxDepth && ++state.nodes <= CODEC_LIMITS.maxNodes, 'Value exceeds codec traversal limits', 'limits_exceeded');
    codecAssert(typeof type === 'string' && type.length <= 1024, 'Invalid ABI type name');
    const resolved = resolve(type);
    const array = /^(.*)\[(\d*)\]$/.exec(resolved);
    if (array) {
      const element = array[1]!;
      const fixed = array[2] === '' ? undefined : Number(array[2]);
      codecAssert(fixed === undefined || (Number.isSafeInteger(fixed) && fixed <= CODEC_LIMITS.maxItems), 'Fixed array exceeds codec limit', 'limits_exceeded');
      if (reader) {
        const count = fixed ?? reader.count();
        return Array.from({length: count}, () => walk(element, reader, undefined, undefined, depth + 1, state, false));
      }
      codecAssert(Array.isArray(value) && value.length <= CODEC_LIMITS.maxItems && (fixed === undefined || value.length === fixed), 'Invalid array length');
      if (fixed === undefined) writer!.varuint(value.length);
      for (const entry of value) walk(element, undefined, writer, entry, depth + 1, state, false);
      return;
    }
    if (resolved.endsWith('?')) {
      if (reader) {const present = reader.u8(); codecAssert(present <= 1, 'Invalid optional presence marker'); return present ? walk(resolved.slice(0, -1), reader, undefined, undefined, depth + 1, state, extensionsAllowed) : null; }
      writer!.u8(value === null || value === undefined ? 0 : 1);
      if (value !== null && value !== undefined) walk(resolved.slice(0, -1), undefined, writer, value, depth + 1, state, extensionsAllowed);
      return;
    }
    codecAssert(!resolved.endsWith('$'), 'Binary extension requires a containing struct');
    const integerType = INTEGER.exec(resolved);
    if (integerType || resolved === 'varint_int64' || resolved === 'varint_uint64') {
      const bits = integerType ? Number(integerType[2]) : 64;
      const signed = integerType ? integerType[1] === 'int' : resolved === 'varint_int64';
      if (reader) {const result = reader.uint(bits / 8, signed); return bits <= 32 ? Number(result) : result.toString(); }
      writer!.uint(value, bits / 8, signed); return;
    }
    if (resolved === 'bool') {if (reader) return reader.u8(); writer!.u8(typeof value === 'boolean' ? Number(value) : value); return; }
    if (resolved === 'varuint32' || resolved === 'varint32') {
      if (reader) {const result = reader.varuint(); return resolved === 'varuint32' ? result : (result >>> 1) ^ -(result & 1); }
      const number = Number(integer(value, 32, resolved === 'varint32'));
      writer!.varuint(resolved === 'varuint32' ? number : ((number << 1) ^ (number >> 31)) >>> 0); return;
    }
    if (resolved === 'string') {if (reader) return reader.text(); writer!.text(value); return; }
    if (resolved === 'bytes' || /^checksum(160|256|512)$/.test(resolved) || resolved === 'float128') {
      const width = resolved === 'bytes' ? undefined : resolved === 'float128' ? 16 : Number(resolved.slice(8)) / 8;
      if (reader) return `${resolved === 'float128' ? '0x' : ''}${toHex(reader.take(width ?? reader.varuint()))}`;
      const input = text(value);
      codecAssert(resolved !== 'float128' || input.startsWith('0x'), 'Expected float128 hexadecimal carrier');
      const bytes = fromHex(resolved === 'float128' ? input.slice(2) : input);
      codecAssert(width === undefined || bytes.length === width, 'Incorrect fixed byte length');
      if (width === undefined) writer!.varuint(bytes.length);
      writer!.add(bytes); return;
    }
    if (resolved === 'float32' || resolved === 'float64') {
      const width = resolved === 'float32' ? 4 : 8;
      if (reader) return formatFloat(reader.take(width), width);
      codecAssert(typeof value === 'number' || (typeof value === 'string' && /^(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|-?inf|nan)$/.test(value)), 'Invalid float carrier');
      const number = value === 'inf' ? Infinity : value === '-inf' ? -Infinity : value === 'nan' ? NaN : Number(value);
      codecAssert(typeof value !== 'number' || Number.isFinite(value), 'Nonfinite floats require a string carrier');
      const bytes = new Uint8Array(width);
      const view = new DataView(bytes.buffer);
      if (width === 4) view.setFloat32(0, number, true); else view.setFloat64(0, number, true);
      writer!.add(bytes); return;
    }
    if (resolved === 'name' || resolved === 'slug_name' && profile.slugNameBuiltin) {
      if (reader) return resolved === 'name' ? decodeName(reader.uint(8)) : decodeSlug(reader.uint(8));
      writer!.uint(resolved === 'name' ? encodeName(value) : encodeSlug(value), 8); return;
    }
    if (resolved === 'time_point' || resolved === 'time_point_sec' || resolved === 'block_timestamp_type') {
      if (reader) {
        const raw = reader.uint(resolved === 'time_point' ? 8 : 4, resolved === 'time_point');
        if (resolved === 'time_point' && raw < 0n) return formatNegativeTimePoint(raw);
        const milliseconds = resolved === 'time_point' ? Number(raw / 1000n) : resolved === 'time_point_sec' ? Number(raw) * 1000 : profile.epochMilliseconds + Number(raw) * profile.slotMilliseconds;
        return formatTime(milliseconds, resolved === 'time_point_sec');
      }
      const milliseconds = parseTime(value, resolved === 'time_point_sec');
      codecAssert(resolved !== 'time_point' || milliseconds >= 0, 'Negative time_point requires unsupported node duration JSON semantics', 'unsupported_feature');
      if (resolved === 'time_point') writer!.uint(BigInt(milliseconds) * 1000n, 8, true);
      else if (resolved === 'time_point_sec') writer!.uint(milliseconds / 1000, 4);
      else {const slot = (milliseconds - profile.epochMilliseconds) / profile.slotMilliseconds; codecAssert(Number.isSafeInteger(slot), 'Unaligned Wire block timestamp'); writer!.uint(slot, 4); }
      return;
    }
    if (resolved === 'symbol' || resolved === 'symbol_code') {
      if (reader) return symbolText(reader.uint(8), resolved === 'symbol_code');
      writer!.uint(symbolRaw(value, resolved === 'symbol_code'), 8); return;
    }
    if (resolved === 'asset') {
      if (reader) {
        const amount = reader.uint(8, true);
        codecAssert(amount >= -(2n ** 62n - 1n) && amount <= 2n ** 62n - 1n, 'Asset amount exceeds Wire range');
        const [precisionText, name] = symbolText(reader.uint(8)).split(',');
        const precision = Number(precisionText);
        const digits = (amount < 0n ? -amount : amount).toString().padStart(precision + 1, '0');
        return `${amount < 0n ? '-' : ''}${precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}` : digits} ${name}`;
      }
      const asset = parseAsset(value); writer!.uint(asset.amount, 8, true); writer!.uint(asset.symbol, 8); return;
    }
    if (resolved === 'extended_asset') {
      if (reader) return {quantity: walk('asset', reader, undefined, undefined, depth + 1, state, false), contract: walk('name', reader, undefined, undefined, depth + 1, state, false)};
      const object = plainObject(value);
      codecAssert(Object.keys(object).length === 2 && Object.hasOwn(object, 'quantity') && Object.hasOwn(object, 'contract'), 'Invalid extended_asset');
      walk('asset', undefined, writer, object.quantity, depth + 1, state, false); walk('name', undefined, writer, object.contract, depth + 1, state, false); return;
    }
    if (resolved === 'bitset') {
      if (reader) {
        const count = reader.count();
        const bytes = reader.take(Math.ceil(count / 8));
        let result = '';
        for (let index = count - 1; index >= 0; index--) result += (bytes[Math.floor(index / 8)]! >> (index % 8)) & 1 ? '1' : '0';
        return result;
      }
      const bits = text(value);
      codecAssert(bits.length <= CODEC_LIMITS.maxItems && /^[01]*$/.test(bits), 'Invalid bitset');
      writer!.varuint(bits.length); const bytes = new Uint8Array(Math.ceil(bits.length / 8));
      for (let index = 0; index < bits.length; index++) if (bits[bits.length - index - 1] === '1') bytes[Math.floor(index / 8)]! |= 1 << (index % 8);
      writer!.add(bytes); return;
    }
    if (resolved === 'public_key' || resolved === 'signature') {
      if (reader) {const result = decodeWireCrypto(resolved, reader.bytes.subarray(reader.offset)); reader.take(result.bytesRead); return result.value; }
      writer!.add(encodeWireCrypto(resolved, value)); return;
    }
    if (resolved.startsWith('protobuf::')) {
      const descriptor = protobuf?.getMessage(resolved.slice(10));
      codecAssert(descriptor, `Missing protobuf type ${resolved}`, 'unsupported_feature');
      try {
        if (reader) {
          const framed = new BinaryReader(reader.take(reader.varuint()));
          const payload = framed.take(framed.varuint()); framed.done();
          preflightProtobuf(descriptor, payload, protobuf, depth, state);
          const message = fromBinary(descriptor, payload, {recursionLimit: CODEC_LIMITS.maxDepth, readUnknownFields: false});
          return jsonSnapshot(toJson(descriptor, message, {useProtoFieldName: true, registry: protobuf}));
        }
        const message = fromJson(descriptor, jsonSnapshot(value), {ignoreUnknownFields: true, registry: protobuf, recursionLimit: CODEC_LIMITS.maxDepth});
        const payload = toBinary(descriptor, message);
        preflightProtobuf(descriptor, payload, protobuf, depth, state);
        const framed = new BinaryWriter(); framed.varuint(payload.length); framed.add(payload);
        const bytes = framed.finish(); writer!.varuint(bytes.length); writer!.add(bytes); return;
      } catch (error) {
        if (error instanceof WireCodecError) throw error;
        throw new WireCodecError('invalid_value', `Invalid protobuf value: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const definition = enums.get(resolved);
    if (definition) {
      if (reader) {const result = walk(definition.type, reader, undefined, undefined, depth + 1, state, false); return definition.values.find(member => member.value === String(result))?.name ?? result; }
      let selected = value;
      if (typeof value === 'string') {
        const exact = definition.values.find(member => member.name === value);
        const suffix = definition.values.filter(member => member.name.includes('_') && member.name.slice(member.name.lastIndexOf('_') + 1) === value);
        if (exact) selected = exact.value;
        else if (suffix.length === 1) selected = suffix[0]!.value;
        else if (/^-?(0|[1-9][0-9]*)$/.test(value) && Number(INTEGER.exec(definition.type)?.[2]) >= 64) selected = value;
        else throw new WireCodecError('invalid_value', `Unknown or ambiguous enum member ${value}`);
      }
      walk(definition.type, undefined, writer, selected, depth + 1, state, false); return;
    }
    const variant = variants.get(resolved);
    if (variant) {
      if (reader) {const tag = reader.varuint(); codecAssert(tag < variant.length, 'Invalid variant discriminator'); return [variant[tag], walk(variant[tag]!, reader, undefined, undefined, depth + 1, state, extensionsAllowed)]; }
      codecAssert(Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && variant.includes(value[0]), 'Invalid variant carrier');
      writer!.varuint(variant.indexOf(value[0])); walk(value[0], undefined, writer, value[1], depth + 1, state, extensionsAllowed); return;
    }
    if (structs.has(resolved)) {
      const fields = fieldsFor(resolved);
      const result: Record<string, unknown> = {};
      const object = reader ? undefined : plainObject(value);
      if (object) codecAssert(Object.keys(object).every(key => fields.some(field => field.name === key)), `Unexpected field in ${resolved}`);
      let omitted = false;
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index]!;
        const extension = field.type.endsWith('$');
        const fieldType = extension ? field.type.slice(0, -1) : field.type;
        if (reader) {
          if (extension && reader.remaining === 0 && extensionsAllowed) continue;
          Object.defineProperty(result, field.name, {value: walk(fieldType, reader, undefined, undefined, depth + 1, state, extensionsAllowed && index === fields.length - 1), enumerable: true, writable: true, configurable: true});
        } else {
          const present = Object.hasOwn(object!, field.name);
          if (!present && extension && extensionsAllowed) {omitted = true; continue; }
          codecAssert(!omitted && (present || fieldType.endsWith('?')), `Missing or misplaced field ${field.name}`);
          walk(fieldType, undefined, writer, present ? object![field.name] : null, depth + 1, state, extensionsAllowed && index === fields.length - 1);
        }
      }
      return result;
    }
    throw new WireCodecError('unsupported_feature', `Unsupported required ABI type ${resolved}`);
  }
  return {
    decode(type, bytes) {codecAssert(knownType(type), `Unsupported required ABI type ${type}`, 'unsupported_feature'); const reader = new BinaryReader(bytes); const result = walk(type, reader, undefined, undefined, 0, {nodes: 0}, true); reader.done(); return result; },
    encode(type, value) {codecAssert(knownType(type), `Unsupported required ABI type ${type}`, 'unsupported_feature'); checkInputBudget(value); const writer = new BinaryWriter(); walk(type, undefined, writer, value, 0, {nodes: 0}, true); return writer.finish(); },
  };
}
