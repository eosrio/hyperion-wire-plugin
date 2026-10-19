import {createHash, ECDH} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {BinaryReader, BinaryWriter, fromHex, toHex} from './codec/binary.js';
import {codecAssert, WireCodecError} from './codec/errors.js';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const suites = ['K1', 'R1', 'WA', 'EM', 'ED', 'BLS'] as const;
type CryptoKind = 'public_key' | 'signature';

function base58Encode(bytes: Uint8Array): string {
  codecAssert(bytes.length <= 4100, 'Crypto carrier exceeds formatting budget', 'limits_exceeded');
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let result = '';
  while (value) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}

function base58Decode(text: string): Uint8Array {
  // A WA frame can contain variable strings. Bound before expensive BigInt work.
  codecAssert(text.length > 0, 'Invalid crypto base58 length');
  codecAssert(text.length <= 8192, 'Crypto text exceeds decoding budget', 'limits_exceeded');
  let value = 0n;
  for (const character of text) {
    const index = alphabet.indexOf(character);
    codecAssert(index >= 0, 'Invalid base58 character');
    value = value * 58n + BigInt(index);
  }
  const suffix: number[] = [];
  while (value) { suffix.push(Number(value & 255n)); value >>= 8n; }
  suffix.reverse();
  const zeros = text.match(/^1*/)?.[0].length ?? 0;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...suffix]);
}

function checksum(data: Uint8Array, suite = ''): Uint8Array {
  return createHash('ripemd160').update(data).update(suite).digest().subarray(0, 4);
}

function checked(data: Uint8Array, suite = ''): Uint8Array {
  return Uint8Array.from([...data, ...checksum(data, suite)]);
}

function uncheck(bytes: Uint8Array, suite = ''): Uint8Array {
  codecAssert(bytes.length >= 4, 'Truncated crypto checksum');
  const data = bytes.subarray(0, -4);
  codecAssert(checksum(data, suite).every((byte, i) => byte === bytes[bytes.length - 4 + i]), 'Invalid crypto checksum');
  return data;
}

function parsePayload(kind: CryptoKind, tag: number, reader: BinaryReader): Uint8Array {
  const start = reader.offset;
  const publicKey = kind === 'public_key';
  const boundedText = () => {
    const offset = reader.offset;
    codecAssert(reader.varuint() <= 4096, 'Crypto text exceeds frame budget', 'limits_exceeded');
    reader.offset = offset;
    return reader.text();
  };
  if (tag === 0 || tag === 1 || tag === 3) reader.take(publicKey ? 33 : 65);
  else if (tag === 4) reader.take(publicKey ? 32 : 96);
  else if (tag === 5) {
    const length = publicKey ? 96 : 192;
    // Generic crypto variants reflect bls::*_shim's shared_ptr, unlike the
    // standalone BLS types that carry a varuint size.
    codecAssert(reader.u8() === 1, 'BLS shim requires a present payload');
    reader.take(length);
  } else if (tag === 2) {
    reader.take(publicKey ? 33 : 65);
    if (publicKey) {
      reader.u8();
      codecAssert(boundedText().length > 0, 'WebAuthn rpid must be nonempty');
    } else {
      const length = reader.varuint();
      codecAssert(length <= 4096, 'Crypto bytes exceed frame budget', 'limits_exceeded');
      reader.take(length);
      boundedText();
    }
  } else throw new WireCodecError('unsupported_feature', 'Unknown crypto suite');
  codecAssert(reader.offset - start <= 4096, 'Crypto frame exceeds formatting budget', 'limits_exceeded');
  return reader.bytes.subarray(start, reader.offset);
}

/** Format only: this layer does not authenticate signatures or verify BLS proofs. */
export function decodeWireCrypto(kind: CryptoKind, bytes: Uint8Array): {value: string; bytesRead: number} {
  const reader = new BinaryReader(bytes);
  const tag = reader.varuint();
  const payload = parsePayload(kind, tag, reader);
  const suite = suites[tag]!;
  const prefix = kind === 'public_key' ? 'PUB' : 'SIG';
  let text: string;
  if (tag <= 2) text = base58Encode(checked(payload, suite));
  else if (tag === 3 && kind === 'public_key') {
    try { text = toHex(new Uint8Array(ECDH.convertKey(payload, 'secp256k1', undefined, undefined, 'uncompressed') as Buffer)); }
    catch { throw new WireCodecError('invalid_value', 'Invalid EM curve point'); }
  } else if (tag === 3) text = '0x' + toHex(payload);
  else if (tag === 4) text = base58Encode(payload);
  else {
    const body = new BinaryReader(payload);
    body.u8();
    text = Buffer.from(checked(body.take(kind === 'public_key' ? 96 : 192))).toString('base64url');
  }
  return {value: `${prefix}_${suite}_${text}`, bytesRead: reader.offset};
}

export function encodeWireCrypto(kind: CryptoKind, value: unknown): Uint8Array {
  codecAssert(typeof value === 'string', 'Expected a crypto string');
  codecAssert(value.length <= 8200, 'Crypto text exceeds decoding budget', 'limits_exceeded');
  const base = kind === 'public_key' ? 'PUB' : 'SIG';
  let suite: string;
  let payload: Uint8Array;
  if (kind === 'public_key' && value.startsWith('SYS')) {
    suite = 'K1';
    payload = uncheck(base58Decode(value.slice(3)));
  } else {
    const match = new RegExp(`^${base}_([A-Z0-9]+)_(.+)$`).exec(value);
    codecAssert(match, 'Invalid crypto prefix');
    suite = match[1]!;
    const text = match[2]!;
    if (suite === 'EM') {
      let hex = text.startsWith('0x') ? text.slice(2) : text;
      if (kind === 'public_key') {
        codecAssert([66, 128, 130].includes(hex.length), 'Invalid EM public key length');
        if (hex.length === 128) hex = '04' + hex;
        try { payload = new Uint8Array(ECDH.convertKey(fromHex(hex), 'secp256k1', undefined, undefined, 'compressed') as Buffer); }
        catch { throw new WireCodecError('invalid_value', 'Invalid EM curve point'); }
      } else payload = fromHex(hex);
    } else if (suite === 'ED') payload = base58Decode(text);
    else if (suite === 'BLS') {
      codecAssert(/^[A-Za-z0-9_-]+$/.test(text), 'Invalid base64url');
      const decoded = Buffer.from(text, 'base64url');
      codecAssert(decoded.toString('base64url') === text, 'Noncanonical base64url');
      const data = uncheck(decoded);
      const writer = new BinaryWriter();
      writer.add(Uint8Array.of(1)); writer.add(data); payload = writer.finish();
    } else {
      codecAssert(['K1', 'R1', 'WA'].includes(suite), 'Unknown crypto suite', 'unsupported_feature');
      payload = uncheck(base58Decode(text), suite);
    }
  }
  const tag = suites.indexOf(suite as typeof suites[number]);
  codecAssert(tag >= 0, 'Unknown crypto suite', 'unsupported_feature');
  const check = new BinaryReader(payload);
  parsePayload(kind, tag, check); check.done();
  const writer = new BinaryWriter();
  writer.varuint(tag); writer.add(payload);
  return writer.finish();
}
