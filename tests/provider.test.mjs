import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createProtocolProvider} from '../dist/provider.js';
import {createWireValueCodec, codecProfiles, nativeActionProfileId, resolveCodecProfile} from '../dist/index.js';
import {validateProtocolSelection} from '@eosrio/hyperion-sdk/protocol';

const root = new URL('../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const bytes = hex => new Uint8Array(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const handshake = json('fixtures/codec/ship.abi.json');
const chain = 'a'.repeat(64), block = 'b'.repeat(64);
const contractAbi = type => ({version: 'sysio::abi/1.3', tables: [{name: 'records', index_type: '',
  key_names: [], key_types: [], type, table_id: 0, secondary_indexes: [{name: 'owner', key_type: 'uint64', table_id: 65535}]}]});

for (const profile of codecProfiles) {
  test(`${profile.id}: stateful v2 preserves primary/secondary namespace, keys and actual payer`, () => {
    const provider = createProtocolProvider(profile.id), port = provider.statefulTables;
    assert.equal(port.interfaceVersion, 2);
    const transport = createWireValueCodec(handshake, profile);
    const abi = {...contractAbi('stateful_record'), structs: [{name: 'stateful_record', base: '',
      fields: [{name: 'id', type: 'uint64'}, {name: 'owner', type: 'name'}]}]};
    const abiHex = hex(provider.contractCodec.encodeAbi(abi));
    const deployment = {id: 'constructed-stateful-epoch', from: {blockNum: 10, ordinal: 2},
      abi: provider.contractCodec.decodeAbi(bytes(abiHex)), abiHex};
    const context = {chainId: chain, blockId: block, blockNum: 10, ordinal: 2, abiDeployment: deployment};
    const value = {id: '18446744073709551615', owner: 'alice'};
    const row = ['contract_row_kv_v0', {code: 'contract', payer: 'payer', table_id: 0,
      key: '000001', value: hex(provider.contractCodec.encodeValue(deployment.abi, 'stateful_record', value))}];
    const raw = transport.encode('contract_row_kv', row);
    const input = {stream: 'contract_row_kv', present: true, raw, value: transport.decode('contract_row_kv', raw)};
    const snapshot = structuredClone(input);
    assert.deepEqual(port.normalizeDelta(input, {...context, abiDeployment: undefined}), {kind: 'abi-required', account: 'contract'});
    const selected = port.normalizeDelta(input, context);
    assert.deepEqual(selected, {kind: 'table', contract: 'contract', tableName: 'records',
      identity: {kind: 'kv-primary', tableId: 0, keyHex: '000001'}, payer: 'payer', present: true,
      source: {chainId: chain, blockId: block, blockNum: 10, ordinal: 2, abiDeployment: deployment.id}, value});
    assert.equal(Object.hasOwn(selected.identity, 'scope'), false);
    assert.deepEqual(input.value, snapshot.value); assert.equal(hex(input.raw), hex(snapshot.raw));
    const secondary = ['contract_index_kv_v0', {code: 'contract', payer: 'otherpayer', table_id: 65535,
      sec_key: '0000', pri_key: '000001'}];
    const secondaryRaw = transport.encode('contract_index_kv', secondary);
    const index = port.normalizeDelta({stream: 'contract_index_kv', present: true, raw: secondaryRaw,
      value: transport.decode('contract_index_kv', secondaryRaw)}, context);
    assert.deepEqual(index.identity, {kind: 'kv-secondary', tableId: 65535, secondaryKeyHex: '0000', primaryKeyHex: '000001'});
    assert.equal(index.payer, 'otherpayer'); assert.equal(index.value, null); assert.equal(index.present, true);
    assert.equal(Object.hasOwn(index.identity, 'scope'), false);
    const removedRaw = transport.encode('contract_row_kv', [row[0], {...row[1], value: ''}]);
    const removed = port.normalizeDelta({...input, present: false, raw: removedRaw,
      value: transport.decode('contract_row_kv', removedRaw)}, context);
    assert.deepEqual(removed.identity, selected.identity); assert.equal(removed.value, null); assert.equal(removed.payer, 'payer');
    assert.equal(removed.present, false);
    assert.throws(() => port.normalizeDelta({...input, value: [row[0], {...row[1], key: '01'}]}, context), /does not match/);
    assert.throws(() => port.normalizeDelta(input, {...context, abiDeployment: {...deployment, abi: contractAbi('uint32')}}), /does not match/);
    for (const stream of ['account', 'permission', 'resource_limits_state']) {
      const ignored = port.normalizeDelta({stream, present: true, raw: new Uint8Array(), value: {}}, context);
      assert.equal(ignored.kind, 'ignore'); assert.ok(ignored.reason.length);
    }
    assert.throws(() => port.normalizeDelta({stream: 'future_required_stream', present: true, raw: new Uint8Array(), value: {}}, context), /Unsupported required/);
  });

  test(`${profile.id}: SDK normalization binds raw compound identities to an explicit deployment`, () => {
    const provider = createProtocolProvider(profile.id);
    const transport = createWireValueCodec(handshake, profile);
    const abi = provider.contractCodec.decodeAbi(provider.contractCodec.encodeAbi(contractAbi('uint64')));
    const deployment = {id: 'contract:abi:1', from: {blockNum: 10, ordinal: 2}, until: {blockNum: 10, ordinal: 5},
      abi, abiHex: hex(provider.contractCodec.encodeAbi(abi))};
    const context = {chainId: chain, blockId: block, blockNum: 10, ordinal: 2};
    const row = ['contract_row_kv_v0', {code: 'contract', payer: 'payer', table_id: 0,
      key: 'ab'.repeat(2000), value: 'ffffffffffffffff'}];
    const raw = transport.encode('contract_row_kv', row);
    const input = {stream: 'contract_row_kv', present: true, raw, value: transport.decode('contract_row_kv', raw)};
    assert.deepEqual(provider.normalizeDelta(input, context), {kind: 'abi-required', account: 'contract'});
    const normalized = provider.normalizeDelta(input, {...context, abiDeployment: deployment});
    assert.equal(normalized.kind, 'record');
    assert.equal(normalized.tableName, 'records');
    assert.equal(normalized.value, '18446744073709551615');
    assert.equal(normalized.record.keyHex, row[1].key);
    assert.equal(normalized.metadata.rawHex, hex(raw));
    assert.equal(normalized.metadata.recordKind, 'row');
    assert.equal(normalized.metadata.code, 'contract');
    assert.equal(normalized.metadata.payer, 'payer');
    assert.equal(normalized.metadata.primaryTableId, 0);
    assert.equal(normalized.source.abiDeployment, deployment.id);
    assert.ok(normalized.identity.endsWith(row[1].key));
    assert.equal(Object.hasOwn(normalized.metadata, 'abiHex'), false, 'do not duplicate ABI bodies per history record');
    const removedRaw = transport.encode('contract_row_kv', [row[0], {...row[1], value: ''}]);
    const removed = provider.normalizeDelta({...input, present: false, raw: removedRaw,
      value: transport.decode('contract_row_kv', removedRaw)}, {...context, abiDeployment: deployment});
    assert.equal(removed.identity, normalized.identity);
    assert.equal(removed.record.present, false);
    assert.equal(Object.hasOwn(removed, 'value'), false);
    const secondary = ['contract_index_kv_v0', {code: 'contract', payer: 'payer', table_id: 65535,
      sec_key: 'cd'.repeat(2001), pri_key: row[1].key}];
    const secondaryRaw = transport.encode('contract_index_kv', secondary);
    const index = provider.normalizeDelta({stream: 'contract_index_kv', present: false, raw: secondaryRaw,
      value: transport.decode('contract_index_kv', secondaryRaw)}, {...context, abiDeployment: deployment});
    assert.equal(index.metadata.recordKind, 'index');
    assert.equal(index.metadata.secondaryName, 'owner');
    assert.equal(index.record.secondaryKeyHex, secondary[1].sec_key);
    assert.equal(index.record.primaryKeyHex, row[1].key);
    assert.notEqual(index.identity, normalized.identity);
    for (const ordinal of [1, 5]) assert.throws(() => provider.normalizeDelta(input,
      {...context, ordinal, abiDeployment: deployment}), /Missing ABI deployment/);
    assert.throws(() => provider.normalizeDelta(input, {...context, abiDeployment: {...deployment, abi: contractAbi('uint32')}}), /does not match/);
    assert.throws(() => provider.normalizeDelta({...input, value: [row[0], {...row[1], key: 'ff'}]},
      {...context, abiDeployment: deployment}), /does not match/);
  });
}

test('selected SDK session decodes the complete captured bundle and validates every stream', () => {
  const profile = codecProfiles[1];
  const provider = createProtocolProvider(profile.id);
  const session = provider.createShipSession(handshake);
  const fixture = json('fixtures/codec/ship-vectors.json');
  const vector = fixture.vectors.find(entry => entry.id === 'captured-ship-block-result');
  const result = session.decodeResult(bytes(vector.hex));
  assert.equal(result[0], 'get_blocks_result_v0');
  const envelope = result[1];
  assert.ok(session.decodeBlock(bytes(envelope.block)));
  assert.equal(session.decodeTraces(bytes(envelope.traces)).length, 1);
  const deltas = session.decodeDeltas(bytes(envelope.deltas));
  assert.ok(Array.isArray(deltas));
  let rows = 0;
  for (const [, delta] of deltas) for (const row of delta.rows) {
    const raw = bytes(row.data);
    const value = session.decodeRow(delta.name, raw);
    const normalized = provider.normalizeDelta({stream: delta.name, present: Boolean(row.present), raw, value}, {});
    if (delta.name === 'resource_limits_state') {
      assert.equal(normalized.kind, 'ignore');
      assert.ok(normalized.reason.includes('resource limit state'));
    } else assert.equal(normalized.kind, 'passthrough');
    rows++;
  }
  assert.ok(rows > 0);
  const request = fixture.vectors.find(entry => entry.typeName === 'request');
  const codec = createWireValueCodec(handshake, profile);
  assert.equal(hex(session.encodeRequest(codec.decode('request', bytes(request.hex)))), request.hex);
  assert.throws(() => session.decodeRow('future_required_stream', new Uint8Array()), /Unsupported required/);
  assert.throws(() => session.decodeDeltas(codec.encode('table_delta[]', [
    ['table_delta_v0', {name: 'future_required_stream', rows: []}]
  ])), /Unsupported required/, 'unknown empty streams must fail before downstream handler selection');
  assert.throws(() => provider.normalizeDelta({stream: 'future_required_stream', present: true, raw: new Uint8Array(), value: {}}, {}), /Unsupported required/);
});

test('sessions and profiles remain independent and require an explicit supported profile', () => {
  const provider = createProtocolProvider(codecProfiles[0].id);
  const schema = type => ({version: 'sysio::abi/1.3', structs: [
    {name: 'signed_block', fields: [{name: 'number', type}]}],
    variants: [{name: 'request', types: ['signed_block']}, {name: 'result', types: ['signed_block']}]});
  const first = provider.createShipSession(schema('uint32'));
  const second = provider.createShipSession(schema('uint64'));
  assert.deepEqual(first.decodeBlock(bytes('01000000')), {number: 1});
  assert.deepEqual(second.decodeBlock(bytes('0200000000000000')), {number: '2'});
  assert.deepEqual(first.decodeBlock(bytes('03000000')), {number: 3});
  assert.throws(() => createProtocolProvider(), /explicit Wire profile/);
  assert.throws(() => createProtocolProvider('unknown'), /Unknown Wire/);
});

test('known unprojected streams are explicitly declared instead of silently filtered by core', () => {
  const provider = createProtocolProvider(codecProfiles[0].id);
  for (const stream of ['account_metadata', 'code', 'protocol_state', 'resource_limits_config', 'resource_limits_state']) {
    const result = provider.normalizeDelta({stream, present: true, raw: new Uint8Array(), value: {}}, {});
    assert.equal(result.kind, 'ignore'); assert.ok(result.reason.length > 0);
  }
});

test('inert descriptors bind both coordinated components to actual package file bytes', () => {
  const descriptor = json('dist/protocol-provider.json');
  const components = descriptor.profiles[0].components;
  assert.equal(validateProtocolSelection(descriptor, {profileId: codecProfiles[0].id,
    environment: {hyperion: '4.0.7', sdk: '0.0.0-dev.1'}, components}).valid, true);
  for (const component of components) {
    const file = `dist/protocol-${component.runtime}-artifact.json`;
    const raw = readFileSync(new URL(file, root));
    assert.equal(createHash('sha256').update(raw).digest('hex'), component.sha256);
    const manifest = JSON.parse(raw);
    assert.equal(manifest.id, component.id);
    assert.equal(manifest.sourceRevision, component.sourceRevision);
    assert.equal(typeof manifest.sourceModified, 'boolean');
    assert.ok(manifest.files.some(entry => entry.path === 'protocol-profile.json'), 'compiled-in Rust profile must be hashed');
    if (component.runtime === 'node') assert.ok(manifest.files.some(entry => entry.path === 'dist/provider.js'));
    if (component.runtime === 'rust') assert.equal(manifest.kind, 'source-only-engineering');
    for (const entry of manifest.files) assert.equal(createHash('sha256').update(readFileSync(new URL(entry.path, root))).digest('hex'), entry.sha256, entry.path);
  }
});

test('only the explicit native profile declares and exposes the required interface', () => {
  const descriptor = json('dist/protocol-provider.json');
  assert.deepEqual(codecProfiles.map(profile => profile.id), [
    'wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1', nativeActionProfileId]);
  assert.equal(resolveCodecProfile().id, codecProfiles[0].id, 'default dialect remains contract-only');
  for (const profile of descriptor.profiles) {
    const provider = createProtocolProvider(profile.id);
    const selection = {profileId: profile.id, components: profile.components,
      environment: {hyperion: '4.0.7', sdk: '0.0.0-dev.1'}};
    if (profile.id === nativeActionProfileId) {
      assert.deepEqual(profile.nativeActions, {interfaceVersion: 1});
      assert.equal(provider.nativeActions.interfaceVersion, 1);
      const rejected = validateProtocolSelection(descriptor, selection);
      assert.equal(rejected.valid, false);
      assert(rejected.errors.some(error => error.code === 'protocol.unsupported-native-interface'));
      assert.equal(validateProtocolSelection(descriptor, {...selection, nativeActionInterfaceVersions: [1]}).valid, true);
    } else {
      assert.equal(Object.hasOwn(profile, 'nativeActions'), false);
      assert.equal(Object.hasOwn(provider, 'nativeActions'), false);
      assert.equal(validateProtocolSelection(descriptor, selection).valid, true);
    }
  }
});
