import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createWireShipCodec, createWireValueCodec, createWireDeploymentRegistry, encodeWireAbi, resolveCodecProfile} from '../dist/index.js';

const profile = resolveCodecProfile();
const hex = value => Buffer.from(value).toString('hex');
const abi = (type = 'uint64', tableId = 0) => ({version: 'sysio::abi/1.3', types: [], structs: [], actions: [],
  tables: [{name: 'dynamic_table', index_type: '', key_names: [], key_types: [], type, table_id: tableId,
    secondary_indexes: [{name: 'owner_slug', key_type: 'slug_name', table_id: 65535}]}]});
const deployment = (id = 'abi-v1', input = abi(), from = {blockNum: 10, ordinal: 2}, until) => ({
  id, chainId: 'a'.repeat(64), contract: '42', from, ...(until ? {until} : {}),
  abiHex: hex(encodeWireAbi(input)), profileId: profile.id,
});
const source = (abiDeployment = 'abi-v1', blockNum = 10, ordinal = 2) => ({
  chainId: 'a'.repeat(64), blockId: 'b'.repeat(64), blockNum, ordinal, abiDeployment,
});
const record = (overrides = {}) => ({kind: 'contract_row_kv', present: true, code: '42', payer: '43', tableId: 0,
  keyHex: 'ab'.repeat(40), valueHex: 'ffffffffffffffff', ...overrides});

test('deployment decoding retains complete identity/context and numeric zero metadata', () => {
  const registry = createWireDeploymentRegistry([deployment()]);
  const result = registry.decodeKvRecord(record(), source());
  assert.equal(result.value, '18446744073709551615');
  assert.equal(result.primaryTableId, 0);
  assert.equal(result.tableName, 'dynamic_table');
  assert.equal(result.record.payer, '43');
  assert.equal(result.record.keyHex.length, 80);
  assert.deepEqual(result.source, source());
  assert.equal(result.abiHex, deployment().abiHex);
});

test('secondary metadata uses authoritative uint16 IDs and retains both full keys', () => {
  const registry = createWireDeploymentRegistry([deployment()]);
  const input = {kind: 'contract_index_kv', present: true, code: '42', payer: '43', tableId: 65535,
    secondaryKeyHex: 'cd'.repeat(41), primaryKeyHex: 'ef'.repeat(42)};
  const result = registry.decodeKvRecord(input, source());
  assert.equal(result.secondaryName, 'owner_slug');
  assert.equal(result.secondaryKeyType, 'slug_name');
  assert.equal(result.primaryTableId, 0);
  assert.equal(result.record.primaryKeyHex, input.primaryKeyHex);
  assert.equal(result.record.secondaryKeyHex, input.secondaryKeyHex);
});

test('deployment changes within a block use ordinal and an exclusive end', () => {
  const boundary = {blockNum: 10, ordinal: 5};
  const registry = createWireDeploymentRegistry([deployment('abi-v1', abi(), {blockNum: 10, ordinal: 2}, boundary),
    deployment('abi-v2', abi('uint32'), boundary)]);
  assert.equal(registry.decodeKvRecord(record(), source('abi-v1', 10, 4)).value, '18446744073709551615');
  assert.equal(registry.decodeKvRecord(record({valueHex: '02000000'}), source('abi-v2', 10, 5)).value, 2);
  assert.throws(() => registry.decodeKvRecord(record(), source('abi-v1', 10, 5)), /does not match/);
  assert.throws(() => registry.decodeKvRecord(record(), source('abi-v1', 10, 1)), /Missing ABI/);
});

test('missing/ambiguous deployment and table mappings fail without a head fallback', () => {
  for (const input of [[], [deployment('one'), deployment('two')]]) {
    const registry = createWireDeploymentRegistry(input);
    assert.throws(() => registry.decodeKvRecord(record(), source()), /Missing ABI|Ambiguous ABI/);
  }
  assert.throws(() => createWireDeploymentRegistry([deployment(), deployment()]), /Duplicate/);
  const registry = createWireDeploymentRegistry([deployment()]);
  assert.throws(() => registry.decodeKvRecord(record({code: '44'}), source()), /Missing ABI/);
  assert.throws(() => registry.decodeKvRecord(record(), {...source(), chainId: 'c'.repeat(64)}), /Missing ABI/);
  assert.throws(() => registry.decodeKvRecord(record({tableId: 9}), source()), /Missing numeric/);
  const duplicate = abi(); duplicate.tables.push({...duplicate.tables[0], name: 'another'});
  assert.throws(() => createWireDeploymentRegistry([deployment('abi-v1', duplicate)]).decodeKvRecord(record(), source()), /Ambiguous numeric/);
});

test('removed KV rows retain context without trying to decode an absent value', () => {
  const result = createWireDeploymentRegistry([deployment()]).decodeKvRecord(record({present: false, valueHex: ''}), source());
  assert.equal(result.record.present, false);
  assert.equal(result.value, undefined);
});

test('registry snapshots are immutable across host supplied fork views', () => {
  const original = deployment();
  const first = createWireDeploymentRegistry([original]);
  original.abiHex = deployment('other', abi('uint32')).abiHex;
  const next = createWireDeploymentRegistry([original]);
  assert.equal(first.decodeKvRecord(record(), source()).value, '18446744073709551615');
  assert.equal(next.decodeKvRecord(record({valueHex: '03000000'}), source()).value, 3);
  assert.throws(() => next.decodeKvRecord(record(), source()), /trailing/);
});

test('captured SHiP bundle decodes block, traces and every known delta row', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/codec/ship-vectors.json', import.meta.url)));
  const handshake = JSON.parse(readFileSync(new URL('../fixtures/codec/ship.abi.json', import.meta.url)));
  const ship = createWireShipCodec(handshake, resolveCodecProfile('wire-sysio-7dede884-engineering-v1'));
  const vector = fixture.vectors.find(v => v.id === 'captured-ship-block-result');
  const bundle = ship.decodeBundle(new Uint8Array(Buffer.from(vector.hex, 'hex')));
  assert.equal(bundle.rawFrameHex, vector.hex);
  assert.equal(bundle.envelope[0], 'get_blocks_result_v0');
  assert.ok(bundle.block && bundle.traces && bundle.deltas);
  assert.equal(bundle.traces.length, 1);
  assert.ok(bundle.deltaRows.some(row => row.stream === 'account'));
  assert.ok(bundle.deltaRows.every(row => row.rawHex && row.value));
  for (const request of fixture.vectors.filter(v => v.typeName === 'request')) {
    const value = createWireValueCodec(handshake, resolveCodecProfile('wire-sysio-7dede884-engineering-v1')).decode('request', new Uint8Array(Buffer.from(request.hex, 'hex')));
    assert.equal(hex(ship.encodeRequest(value)), request.hex);
  }
});

test('physical SHiP KV normalization retains full raw account/key and source context', () => {
  const handshake = JSON.parse(readFileSync(new URL('../fixtures/codec/ship.abi.json', import.meta.url)));
  const ship = createWireShipCodec(handshake);
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/codec/extra-vectors.json', import.meta.url)));
  for (const vector of fixture.vectors.filter(v => v.typeName === 'contract_row_kv' || v.typeName === 'contract_index_kv')) {
    const normalized = ship.normalizeKvRow(vector.typeName, true, new Uint8Array(Buffer.from(vector.hex, 'hex')), source());
    assert.equal(normalized.rawHex, vector.hex);
    assert.equal(normalized.record.code, BigInt('0xc7b0ea0000000000').toString());
    assert.equal(normalized.record.payer, '0');
    assert.equal(normalized.record.tableId, vector.expected[1].table_id);
    assert.equal(normalized.record.kind === 'contract_row_kv' ? normalized.record.keyHex.length : normalized.record.primaryKeyHex.length, 128);
    assert.deepEqual(normalized.source, source());
  }
});

test('count correction rejects arbitrary trailing data and stream-order changes', () => {
  const handshake = JSON.parse(readFileSync(new URL('../fixtures/codec/ship.abi.json', import.meta.url)));
  const ship = createWireShipCodec(handshake);
  const codec = createWireValueCodec(handshake);
  const delta = (name) => ['table_delta_v0', {name, rows: []}];
  const wrong = codec.encode('table_delta[]', [delta('resource_usage'), delta('resource_limits')]);
  wrong[0] = 1;
  assert.throws(() => ship.decodeDeltas(wrong), /ordering/);
  const missing = codec.encode('table_delta[]', [delta('account'), delta('resource_limits_state')]);
  missing[0] = 1;
  assert.throws(() => ship.decodeDeltas(missing), /requires both/);
  const valid = codec.encode('table_delta[]', [delta('account')]);
  assert.throws(() => ship.decodeDeltas(new Uint8Array([...valid, 0])), /Truncated/);
  assert.deepEqual(ship.decodeDeltas(valid).framing, {declaredCount:1, actualCount:1, compatibility:null});
});
