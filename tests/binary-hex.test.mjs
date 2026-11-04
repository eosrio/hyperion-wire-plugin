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


test('hex encoding preserves iterator ordering, fallback values and abrupt completion', () => {
  const bytes = Uint8Array.from({length: 256}, (_, index) => index);
  assert.equal(toHex(bytes), Buffer.from(bytes).toString('hex'));
  assert.equal(toHex(new Uint8Array()), '');
  const events = [];
  const object = {toString(radix) {events.push(`format:${radix}`); return 'object';}};
  const iterable = {[Symbol.iterator]() {events.push('iterator'); let index = 0; const values = [1, 256, -1, 1.5, NaN, 'z', object];
    return {next() {events.push(`next:${index}`); return index < values.length ? {value: values[index++], done: false} : {done: true};}};}};
  assert.equal(toHex(iterable), '01100-11.8NaN0zobject');
  assert.deepEqual(events, ['iterator', 'next:0', 'next:1', 'next:2', 'next:3', 'next:4', 'next:5', 'next:6', 'format:16', 'next:7']);
  const marker = new Error('iterator failure');
  const throws = {[Symbol.iterator]() {return {next() {throw marker;}};}};
  assert.throws(() => toHex(throws), error => error === marker);
  const formatted = new Error('format failure'); let closed = false;
  const invalid = {[Symbol.iterator]() {return {next() {return {value: {toString() {throw formatted;}}, done: false};}, return() {closed = true; return {};}};}};
  assert.throws(() => toHex(invalid), error => error === formatted); assert.equal(closed, true);
});

test('hex encoding preserves ordinary views and observable iterator overrides', () => {
  const bytes = Uint8Array.from({length: 260}, (_, i) => i);
  const view = bytes.subarray(2, 258);
  const expected = Array.from(view, b => b.toString(16).padStart(2, '0')).join('');
  assert.equal(toHex(view), expected);
  bytes[2] = 77; assert.notEqual(toHex(view), expected);
  const shadow = new Uint8Array([1, 2]);
  Object.defineProperty(shadow, 'buffer', {get() {throw new Error('must not access');}});
  assert.equal(toHex(shadow), '0102');
  let reads = 0;
  Object.defineProperty(shadow, Symbol.iterator, {get() {reads++; return function* () {yield 9;};}});
  assert.equal(toHex(shadow), '09'); assert.equal(reads, 1);
  class Custom extends Uint8Array { *[Symbol.iterator]() {yield 8;} }
  assert.equal(toHex(new Custom([1, 2])), '08');
  assert.equal(toHex({0: 15, 1: 256, length: 2}), '0f100');
  const shared = new Uint8Array(new SharedArrayBuffer(2)); shared.set([3, 4]);
  assert.equal(toHex(shared), '0304');
  const rab = new ArrayBuffer(4, {maxByteLength: 8}); const rabView = new Uint8Array(rab); rabView.set([1,2,3,4]);
  assert.equal(toHex(rabView), '01020304'); rab.resize(2); assert.equal(toHex(rabView), '0102');
  const detached = new Uint8Array([1, 2]); structuredClone(detached.buffer, {transfer: [detached.buffer]});
  assert.throws(() => toHex(detached), TypeError);
});

test('hex encoding honors changed iterator intrinsics', () => {
  const tp = Object.getPrototypeOf(Uint8Array.prototype);
  const original = Object.getOwnPropertyDescriptor(tp, Symbol.iterator);
  let reads = 0;
  try {
    Object.defineProperty(tp, Symbol.iterator, {configurable: true, get() {reads++; return function* () {yield 7;};}});
    assert.equal(toHex(new Uint8Array([1])), '07'); assert.equal(reads, 1);
  } finally { Object.defineProperty(tp, Symbol.iterator, original); }
  const ip = Object.getPrototypeOf(new Uint8Array()[Symbol.iterator]());
  const next = Object.getOwnPropertyDescriptor(ip, 'next');
  try { Object.defineProperty(ip, 'next', {configurable: true, value() {return {done: true};}}); assert.equal(toHex(new Uint8Array([1])), ''); }
  finally { Object.defineProperty(ip, 'next', next); }
});

import {spawnSync} from 'node:child_process';
test('pre-import iterator override falls back without executing at import', () => {
 const code = `const tp=Object.getPrototypeOf(Uint8Array.prototype); let reads=0; Object.defineProperty(tp,Symbol.iterator,{configurable:true,value:function*(){reads++;yield 7}}); const m=await import('./dist/codec/binary.js'); if(reads!==0 || m.toHex(new Uint8Array([1,2]))!=='07' || reads!==1) throw Error('iterator contract');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);
});
