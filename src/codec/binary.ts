import {TextDecoder, TextEncoder} from 'node:util';
import {codecAssert, WireCodecError, type WireCodecErrorCode} from './errors.js';

/** Package limits bound malformed records independently of chain deployment policy. */
export const CODEC_LIMITS = Object.freeze({maxBytes: 16 * 1024 * 1024, maxItems: 100_000, maxDepth: 64, maxNodes: 1_000_000});
const utf8Decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const utf8Encoder = new TextEncoder();

export function fromHex(value: unknown): Uint8Array {
  codecAssert(typeof value === 'string' && value.length % 2 === 0 && /^[0-9a-f]*$/i.test(value), 'Expected complete hexadecimal bytes');
  codecAssert(value.length / 2 <= CODEC_LIMITS.maxBytes, 'Byte input exceeds codec limit', 'limits_exceeded');
  return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}

export function toHex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function integer(value: unknown, bits: number, signed = false): bigint {
  codecAssert((typeof value === 'number' && Number.isSafeInteger(value))
    || (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value))
    || typeof value === 'bigint', 'Expected a lossless integer');
  const number = BigInt(value);
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const maximum = (1n << BigInt(signed ? bits - 1 : bits)) - 1n;
  codecAssert(number >= minimum && number <= maximum, `Integer is outside ${signed ? 'int' : 'uint'}${bits}`);
  return number;
}

export function plainObject(value: unknown, code: WireCodecErrorCode = 'invalid_value'): Record<string, unknown> {
  codecAssert(typeof value === 'object' && value !== null && !Array.isArray(value), 'Expected an object', code);
  const prototype = Object.getPrototypeOf(value);
  codecAssert(prototype === null || prototype === Object.prototype, 'Expected a plain object', code);
  const properties = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(properties)) {
    codecAssert(typeof key === 'string', 'Symbol fields are unsupported', code);
    const property = properties[key]!;
    codecAssert(Object.hasOwn(property, 'value') && property.enumerable, 'Expected enumerable data fields', code);
    result[key] = property.value;
  }
  return result;
}

export class BinaryReader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {
    codecAssert(bytes instanceof Uint8Array, 'Expected Uint8Array');
    codecAssert(bytes.length <= CODEC_LIMITS.maxBytes, 'Byte input exceeds codec limit', 'limits_exceeded');
  }
  get remaining(): number { return this.bytes.length - this.offset; }
  take(count: number): Uint8Array {
    codecAssert(Number.isSafeInteger(count) && count >= 0 && count <= this.remaining, `Truncated binary input at offset ${this.offset}`);
    const result = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return result;
  }
  uint(width: number, signed = false): bigint {
    const bytes = this.take(width);
    let value = 0n;
    for (let index = width - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index]!);
    return signed && (bytes[width - 1]! & 128) ? value - (1n << BigInt(width * 8)) : value;
  }
  u8(): number { return this.take(1)[0]!; }
  varuint(): number {
    let result = 0;
    for (let index = 0; index < 5; index++) {
      const byte = this.u8();
      codecAssert(index < 4 || byte <= 15, 'Varuint32 overflow');
      result += (byte & 127) * 2 ** (7 * index);
      if (!(byte & 128)) {
        codecAssert(index === 0 || byte !== 0, 'Noncanonical varuint32');
        return result;
      }
    }
    throw new WireCodecError('invalid_value', 'Unterminated varuint32');
  }
  count(): number {
    const count = this.varuint();
    codecAssert(count <= CODEC_LIMITS.maxItems, 'Collection exceeds codec limit', 'limits_exceeded');
    return count;
  }
  vector<T>(decode: () => T): T[] { return Array.from({length: this.count()}, decode); }
  text(): string {
    const bytes = this.take(this.varuint());
    try { return utf8Decoder.decode(bytes); }
    catch { throw new WireCodecError('invalid_value', 'Invalid UTF-8 string'); }
  }
  done(): void { codecAssert(this.remaining === 0, `Unexpected trailing bytes at offset ${this.offset}`); }
}

export class BinaryWriter {
  private chunks: Uint8Array[] = [];
  private size = 0;
  add(bytes: Uint8Array): void {
    codecAssert(this.size + bytes.length <= CODEC_LIMITS.maxBytes, 'Encoded output exceeds codec limit', 'limits_exceeded');
    this.chunks.push(bytes);
    this.size += bytes.length;
  }
  uint(value: unknown, width: number, signed = false): void {
    let number = integer(value, width * 8, signed);
    if (number < 0n) number += 1n << BigInt(width * 8);
    const bytes = new Uint8Array(width);
    for (let index = 0; index < width; index++) { bytes[index] = Number(number & 255n); number >>= 8n; }
    this.add(bytes);
  }
  u8(value: unknown): void { this.uint(value, 1); }
  varuint(value: unknown): void {
    let number = Number(integer(value, 32));
    const bytes: number[] = [];
    do {
      const byte = number % 128;
      number = Math.floor(number / 128);
      bytes.push(byte | (number ? 128 : 0));
    } while (number);
    this.add(Uint8Array.from(bytes));
  }
  vector(value: unknown, encode: (item: unknown) => void): void {
    codecAssert(Array.isArray(value), 'Expected an array');
    codecAssert(value.length <= CODEC_LIMITS.maxItems, 'Collection exceeds codec limit', 'limits_exceeded');
    this.varuint(value.length);
    for (const item of value) encode(item);
  }
  text(value: unknown): void {
    codecAssert(typeof value === 'string' && !/[\ud800-\udfff]/u.test(value), 'Expected a valid Unicode string');
    const bytes = utf8Encoder.encode(value);
    this.varuint(bytes.length); this.add(bytes);
  }
  finish(): Uint8Array {
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }
}
