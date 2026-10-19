import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {
  normalizeKvRecord, slotToUnixMilliseconds, unixMillisecondsToSlot, WireProtocolError,
} from '../dist/index.js';

const profile = JSON.parse(await readFile(new URL('../protocol-profile.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('../fixtures/protocol-vectors.json', import.meta.url), 'utf8'));
const source = () => ({chainId: 'a'.repeat(64), blockId: 'b'.repeat(64), blockNum: 1, ordinal: 0, abiDeployment: 'contract@1'});
const row = () => ({kind: 'contract_row_kv', present: true, code: '0', payer: '18446744073709551615', tableId: 0, keyHex: '', valueHex: ''});
const index = () => ({kind: 'contract_index_kv', present: true, code: '0', payer: '0', tableId: 0, secondaryKeyHex: '', primaryKeyHex: ''});
function rejects(code, action) {
  assert.throws(action, error => error instanceof Error && error instanceof WireProtocolError && error.code === code);
}

test('timestamp constants match the shared engineering profile', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.profile, profile);
  assert.equal(profile.epochMilliseconds, slotToUnixMilliseconds(0));
  assert.equal(profile.slotMilliseconds, slotToUnixMilliseconds(1) - slotToUnixMilliseconds(0));
  assert.equal(unixMillisecondsToSlot(profile.epochMilliseconds), 0);
});

for (const vector of fixture.vectors) {
  test(`shared vector: ${vector.id}`, () => {
    const action = () => {
      switch (vector.operation) {
        case 'slotToUnixMilliseconds': return slotToUnixMilliseconds(vector.input);
        case 'unixMillisecondsToSlot': return unixMillisecondsToSlot(vector.input);
        case 'normalizeKvRecord': return normalizeKvRecord(vector.input?.record, vector.input?.source);
        default: throw new Error(`Unsupported vector operation: ${vector.operation}`);
      }
    };
    if (Object.hasOwn(vector, 'expectedError')) rejects(vector.expectedError, action);
    else assert.deepEqual(action(), vector.expected);
  });
}

test('timestamp functions reject non-JSON and coercible values', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, 0n, Symbol('slot'), new Number(0), () => 0, [], {}, {valueOf: () => 0}]) {
    rejects('invalid_slot', () => slotToUnixMilliseconds(value));
    rejects('invalid_timestamp', () => unixMillisecondsToSlot(value));
  }
  assert.equal(slotToUnixMilliseconds(-0), slotToUnixMilliseconds(0));
});

test('normalization retains deletion bytes and snapshots every source field', () => {
  const record = {...row(), present: false, keyHex: '0001ff', valueHex: 'deadbeef'};
  const provenance = source();
  const result = normalizeKvRecord(Object.freeze(record), Object.freeze(provenance));
  assert.deepEqual(result.record, record);
  assert.deepEqual(result.source, provenance);
  assert.notEqual(result.record, record);
  assert.notEqual(result.source, provenance);
  assert.equal(result.identity, `wire-kv-v1:row:${provenance.chainId}:0:0:0001ff`);
});

test('later caller changes do not alter normalized records', () => {
  const record = row();
  const provenance = source();
  const result = normalizeKvRecord(record, provenance);
  record.keyHex = 'ff';
  provenance.abiDeployment = 'changed';
  assert.equal(result.record.keyHex, '');
  assert.equal(result.source.abiDeployment, 'contract@1');
});

test('compound and secondary keys keep full, distinct identities', () => {
  const provenance = source();
  assert.notEqual(normalizeKvRecord({...row(), keyHex: '00010002'}, provenance).identity,
    normalizeKvRecord({...row(), keyHex: '00010003'}, provenance).identity);
  assert.notEqual(normalizeKvRecord({...index(), primaryKeyHex: '0001'}, provenance).identity,
    normalizeKvRecord({...index(), primaryKeyHex: '0002'}, provenance).identity);
  assert.notEqual(normalizeKvRecord({...index(), secondaryKeyHex: '0001'}, provenance).identity,
    normalizeKvRecord({...index(), secondaryKeyHex: '0002'}, provenance).identity);
  assert.notEqual(normalizeKvRecord(row(), provenance).identity, normalizeKvRecord(index(), provenance).identity);
});

test('provenance changes do not change logical identity except chain', () => {
  const provenance = source();
  const initial = normalizeKvRecord(row(), provenance);
  const updated = normalizeKvRecord(row(), {...provenance, blockId: 'c'.repeat(64), blockNum: 2, ordinal: 3, abiDeployment: 'contract@2'});
  assert.equal(updated.identity, initial.identity);
  assert.notDeepEqual(updated.source, initial.source);
  assert.notEqual(normalizeKvRecord(row(), {...provenance, chainId: 'd'.repeat(64)}).identity, initial.identity);
});

test('row and index payer changes retain metadata without changing key identity', () => {
  for (const record of [row(), index()]) {
    const initial = normalizeKvRecord(record, source());
    const updated = normalizeKvRecord({...record, payer: '42'}, source());
    assert.equal(updated.identity, initial.identity);
    assert.equal(updated.record.payer, '42');
  }
});

test('table IDs and ordinals accept negative zero without integer coercion', () => {
  const result = normalizeKvRecord({...row(), tableId: -0}, {...source(), ordinal: -0});
  assert.equal(result.identity, normalizeKvRecord(row(), source()).identity);
  assert(Object.is(result.record.tableId, -0));
  assert(Object.is(result.source.ordinal, -0));
  for (const value of [NaN, Infinity, -Infinity, 1n, new Number(1), undefined]) {
    rejects('invalid_record', () => normalizeKvRecord({...row(), tableId: value}, source()));
    rejects('invalid_source', () => normalizeKvRecord(row(), {...source(), ordinal: value}));
    rejects('invalid_source', () => normalizeKvRecord(row(), {...source(), blockNum: value}));
  }
});

test('records and sources require exact plain data shapes', () => {
  class RecordInstance { constructor() { Object.assign(this, row()); } }
  const sparse = new Array(7);
  for (const value of [undefined, NaN, Infinity, 1n, Symbol('record'), sparse, [], new Date(), new Map(), new RecordInstance()]) {
    rejects('invalid_record', () => normalizeKvRecord(value, source()));
    rejects('invalid_source', () => normalizeKvRecord(row(), value));
  }
  for (const value of [{...row(), extra: undefined}, {...row(), [Symbol('extra')]: 1}, Object.create(row())]) {
    rejects('invalid_record', () => normalizeKvRecord(value, source()));
  }
  for (const value of [{...source(), extra: undefined}, {...source(), [Symbol('extra')]: 1}, Object.create(source())]) {
    rejects('invalid_source', () => normalizeKvRecord(row(), value));
  }
  assert.deepEqual(normalizeKvRecord(Object.assign(Object.create(null), row()), Object.assign(Object.create(null), source())), normalizeKvRecord(row(), source()));
});

test('field getters and hidden fields are rejected without executing getters', () => {
  let reads = 0;
  for (const key of ['kind', 'keyHex']) {
    const record = {...row()};
    Object.defineProperty(record, key, {enumerable: true, get() { reads++; throw new Error('getter ran'); }});
    rejects('invalid_record', () => normalizeKvRecord(record, source()));
  }
  const provenance = source();
  Object.defineProperty(provenance, 'abiDeployment', {enumerable: true, get() { reads++; throw new Error('getter ran'); }});
  rejects('invalid_source', () => normalizeKvRecord(row(), provenance));
  assert.equal(reads, 0);
  const hiddenRecord = row();
  Object.defineProperty(hiddenRecord, 'keyHex', {enumerable: false});
  rejects('invalid_record', () => normalizeKvRecord(hiddenRecord, source()));
  const hiddenSource = source();
  Object.defineProperty(hiddenSource, 'blockId', {enumerable: false});
  rejects('invalid_source', () => normalizeKvRecord(row(), hiddenSource));
});

test('ABI deployment boundaries use the explicit shared Unicode whitespace set', () => {
  const characters = ['\t', '\n', '\v', '\f', '\r', ' ', '\u0085', '\u00a0', '\u1680',
    '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008',
    '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'];
  for (const character of characters) {
    rejects('invalid_source', () => normalizeKvRecord(row(), {...source(), abiDeployment: `${character}abi`}));
    rejects('invalid_source', () => normalizeKvRecord(row(), {...source(), abiDeployment: `abi${character}`}));
    assert.equal(normalizeKvRecord(row(), {...source(), abiDeployment: `abi${character}deployment`}).source.abiDeployment, `abi${character}deployment`);
  }
});

test('ABI deployment identifiers reject unpaired UTF-16 surrogates', () => {
  for (const abiDeployment of ['\ud800', '\udfff', 'valid\ud800text', '\udfff\ud800']) {
    rejects('invalid_source', () => normalizeKvRecord(row(), {...source(), abiDeployment}));
  }
  const abiDeployment = 'contract@\ud83d\ude00';
  assert.equal(normalizeKvRecord(row(), {...source(), abiDeployment}).source.abiDeployment, abiDeployment);
});

test('malformed record takes precedence over malformed provenance', () => {
  rejects('invalid_record', () => normalizeKvRecord(null, null));
});
