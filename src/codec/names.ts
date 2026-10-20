import {codecAssert} from './errors.js';
import {integer, plainObject} from './binary.js';

const NAME_ALPHABET = '.12345abcdefghijklmnopqrstuvwxyz';
const SLUG_ALPHABET = '\0ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';

export function decodeName(raw: bigint): string {
  let result = '';
  for (let index = 0; index < 13; index++) {
    const shift = index === 12 ? 0 : 64 - (index + 1) * 5;
    result += NAME_ALPHABET[Number((raw >> BigInt(shift)) & BigInt(index === 12 ? 15 : 31))]!;
  }
  return result.replace(/\.+$/, '');
}

export function encodeName(value: unknown): bigint {
  codecAssert(typeof value === 'string' && /^[.1-5a-z]{0,13}$/.test(value) && !value.endsWith('.'), 'Invalid sysio name');
  let result = 0n;
  for (let index = 0; index < value.length; index++) {
    const symbol = NAME_ALPHABET.indexOf(value[index]!);
    codecAssert(index !== 12 || symbol <= 15, 'Invalid thirteenth sysio name symbol');
    result |= BigInt(symbol) << BigInt(index === 12 ? 0 : 64 - (index + 1) * 5);
  }
  return result;
}

export function decodeSlug(raw: bigint): string {
  let result = '';
  for (let index = 0; index < 8; index++) {
    const symbol = Number((raw >> BigInt(42 - 6 * index)) & 63n);
    if (symbol === 0) break;
    result += SLUG_ALPHABET[symbol] ?? '\0';
  }
  return result;
}

export function encodeSlug(value: unknown): bigint {
  if (typeof value === 'object' && value !== null) {
    const object = plainObject(value);
    codecAssert(Object.keys(object).length === 1 && Object.hasOwn(object, 'value'), 'Invalid raw slug carrier');
    return integer(object.value, 64);
  }
  codecAssert(typeof value === 'string' && /^(?:[A-Z][A-Z0-9_]{0,7})?$/.test(value), 'Invalid slug_name spelling');
  let result = 0n;
  for (let index = 0; index < value.length; index++) result |= BigInt(SLUG_ALPHABET.indexOf(value[index]!)) << BigInt(42 - 6 * index);
  return result;
}
