import assert from 'node:assert/strict';
import test from 'node:test';
import {fromHex, toHex, CODEC_LIMITS} from '../dist/codec/binary.js';
const old = value => Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
test('hex decode preserves validated bytes, type, offsets and caller storage', () => {
  for (const input of ['', '00', 'aAfF', '0123456789abcdef'.repeat(4096)]) {
    const result = fromHex(input);
    assert.deepEqual(result, old(input));
    assert.equal(Object.getPrototypeOf(result), Uint8Array.prototype);
  }
  const backing = new Uint8Array([99, 0, 128, 255, 88]);
  assert.equal(toHex(backing.subarray(1, 4)), '0080ff');
  const custom = new Uint8Array([1,2]); custom[Symbol.iterator] = function* () {yield 255; yield 16;};
  assert.equal(toHex(custom), 'ff10');
  const first = fromHex('1234'), second = fromHex('1234'); first[0] = 255; assert.equal(second[0], 0x12);
});
test('hex decoder retains malformed/type and limit rejection ordering', () => {
  for (const value of [null, undefined, 0, {}, '0', '0g', 'abcx', 'aaa\n', 'a\n', 'aa\n00', 'aa 00'])
    assert.throws(() => fromHex(value), error => error.code === 'invalid_value');
  const tooLong = 'ab'.repeat(CODEC_LIMITS.maxBytes + 1);
  assert.throws(() => fromHex(tooLong), error => error.code === 'limits_exceeded');
  assert.throws(() => fromHex(tooLong.slice(0, -1) + 'z'), error => error.code === 'invalid_value');
});
