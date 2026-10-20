import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createProtocolProvider} from '../dist/provider.js';
import {createWireShipCodec, createWireValueCodec, resolveCodecProfile} from '../dist/index.js';

const root = new URL('../fixtures/codec/native-genesis-6508-20261020/', import.meta.url);
const read = name => readFileSync(new URL(name, root));
const json = name => JSON.parse(read(name));
const fixture = json('manifest.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const member of fixture.members) {
  const bytes = read(member.path);
  assert.equal(bytes.length, member.bytes); assert.equal(hash(bytes), member.sha256);
}
const original = {schemaJson: read('ship.abi.json').toString('utf8'), block: read('block.bin'), traces: null, deltas: read('deltas.bin')};
const provider = createProtocolProvider(fixture.profileId);
const schema = JSON.parse(original.schemaJson), profile = resolveCodecProfile(fixture.profileId);
const ship = createWireShipCodec(schema, profile), codec = createWireValueCodec(schema, profile);
const headerFields = schema.structs.find(entry => entry.name === 'block_header').fields.map(field => field.name);
// Mutation cases are constructed from the real input using existing codecs. Their
// expected ABI facts stay the independently audited expected.json, never verifier output.
function constructed(edit = () => {}) {
  const block = ship.decodeBlock(original.block);
  const deltas = ship.decodeDeltas(original.deltas).deltas;
  const table = name => deltas.find(([, value]) => value.name === name)[1];
  const records = new Map(deltas.map(([, value]) => [value.name, value.rows.map(row => codec.decode(value.name, Buffer.from(row.data, 'hex')))]));
  const row = (name, index = 0) => records.get(name)[index][1];
  const source = structuredClone(fixture.source);
  edit({block, deltas, table, row, source});
  for (const [, value] of deltas) {
    const values = records.get(value.name);
    if (values) for (let i = 0; i < value.rows.length; i++) {
      if (values[i]) value.rows[i].data = Buffer.from(codec.encode(value.name, values[i])).toString('hex');
    }
  }
  const blockBytes = codec.encode('signed_block', block);
  const bytes = Buffer.from(codec.encode('table_delta[]', deltas));
  bytes[0] = 8; // Reproduce the pinned producer's documented resource-index count defect.
  const header = Object.fromEntries(headerFields.map(name => [name, block[name]]));
  const id = createHash('sha256').update(codec.encode('block_header', header)).digest();
  id.writeUInt32BE(1, 0); source.blockId = id.toString('hex');
  return {input: {...original, block: blockBytes, deltas: bytes}, source};
}
const verify = value => provider.verifyNativeGenesis(value.input, value.source);

test('actual6508 genesis preserves raw absent traces/parent and native ABI barriers', () => {
  assert.equal(typeof provider.verifyNativeGenesis, 'function');
  const before = [hash(original.block), hash(original.deltas)];
  const facts = provider.verifyNativeGenesis(original, fixture.source);
  assert.deepEqual(facts, json('expected.json'));
  assert.equal(fixture.source.previousBlockId, null);
  assert.equal(original.traces, null);
  assert.deepEqual([hash(original.block), hash(original.deltas)], before);
  assert.ok(Object.isFrozen(facts) && Object.isFrozen(facts.abiStates) && facts.abiStates.every(Object.isFrozen));
});

test('captured result independently retains null SHiP predecessor and absent traces', () => {
  const [, result] = ship.decodeResult(read('result.bin'));
  assert.equal(result.prev_block, null); assert.equal(result.traces, null);
  assert.equal(result.this_block.block_id, fixture.source.blockId);
  assert.equal(hash(Buffer.from(result.block, 'hex')), hash(original.block));
  assert.equal(hash(Buffer.from(result.deltas, 'hex')), hash(original.deltas));
});

test('constructed alternate valid slot/key/configuration does not pin one network', () => {
  const value = constructed(({block, row, source}) => {
    block.timestamp = '2026-10-20T00:00:00.000';
    for (let i = 1; i < 9; i++) row('permission', i).last_updated = block.timestamp;
    const key = 'PUB_K1_5p78kHbL33Rn3JWkTWRE2B9uz6gy4r1KbfAKLNQGE3ovLY8E9M';
    for (const i of [1, 2]) row('permission', i).auth.keys[0].key = key;
    row('global_property').configuration[1].max_block_cpu_usage = 500000;
    row('global_property').configuration[1].max_block_net_usage = '18446744073709551615';
    row('global_property').configuration[1].max_action_return_value_size = 20971520;
    source.chainId = 'c'.repeat(64); row('global_property').chain_id = source.chainId;
  });
  assert.notEqual(value.source.blockId, fixture.source.blockId);
  assert.deepEqual(verify(value), json('expected.json'));
});

const crypto = JSON.parse(readFileSync(new URL('../fixtures/codec/crypto-capture.json', import.meta.url)));
for (const suite of ['R1', 'EM', 'ED']) test(`constructed inline ${suite} producer uses source-fixed billing`, () => {
  const command = crypto.commands.find(entry => entry.id === `official-crypto-public_key-${suite}`);
  const key = JSON.parse(command.stdout);
  const value = constructed(({row}) => {for (const i of [1, 2]) row('permission', i).auth.keys[0].key = key;});
  assert.deepEqual(verify(value), json('expected.json'));
});
for (const suite of ['WA', 'BLS']) test(`heap ${suite} genesis is explicitly unsupported, ordinary crypto remains usable`, () => {
  const key = JSON.parse(crypto.commands.find(entry => entry.id === `official-crypto-public_key-${suite}${suite === 'BLS' ? '-valid' : ''}`).stdout);
  assert.equal(codec.decode('public_key', codec.encode('public_key', key)), key);
  const value = constructed(({row}) => {for (const i of [1, 2]) row('permission', i).auth.keys[0].key = key;});
  assert.throws(() => verify(value), error => error.code === 'unsupported_feature' && /heap-key billing/.test(error.message));
});

const semanticMutations = [
  ['native ABI', ({row}) => {row('account').abi = '00';}],
  ['missing empty ABI barrier', ({row}) => {row('account', 1).abi = row('account').abi;}],
  ['same-count duplicate account', ({row}) => {row('account', 1).name = 'sysio';}],
  ['compatibility creation date', ({row}) => {row('account').creation_date = '2026-10-19T00:00:00.000';}],
  ['privileged metadata', ({row}) => {row('account_metadata').privileged = 0;}],
  ['last code update', ({row}) => {row('account_metadata').last_code_update = '2026-10-19T00:00:00.000';}],
  ['foreign chain', ({row}) => {row('global_property').chain_id = 'd'.repeat(64);}],
  ['proposed schedule', ({row}) => {row('global_property').proposed_schedule.version = 1;}],
  ['wasm default', ({row}) => {row('global_property').wasm_configuration[1].max_pages++;}],
  ['protocol activation', ({row}) => {row('protocol_state').activated_protocol_features =
    [['activated_protocol_feature_v0', {feature_digest: 'a'.repeat(64), activation_block_num: 1}]];}],
  ['reserved permission', ({row}) => {row('permission').auth.threshold = 1;}],
  ['owner/active key mismatch', ({row}) => {row('permission', 2).auth.keys = [];}],
  ['permission parent', ({row}) => {row('permission', 8).parent = 'active';}],
  ['permission timestamp', ({row}) => {row('permission', 8).last_updated = '2026-10-18T00:00:00.000';}],
  ['permission authority weight', ({row}) => {row('permission', 6).auth.accounts[0].weight = 2;}],
  ['same-count duplicate resource owner', ({row}) => {row('resource_limits', 2).owner = 'sysio';}],
  ['resource limit', ({row}) => {row('resource_limits').ram_bytes = '0';}],
  ['one-unit RAM mutation', ({row}) => {row('resource_usage').ram_usage = '3168';}],
  ['usage accumulator', ({row}) => {row('resource_usage', 1).net_usage[1].consumed = '1';}],
  ['RAM total', ({row}) => {row('resource_limits_state').total_ram_bytes = '1';}],
  ['resource/global CPU confusion', ({row}) => {row('resource_limits_state').virtual_cpu_limit = '400000';}],
  ['resource target', ({row}) => {row('resource_limits_config').net_limit_parameters[1].target = '104858';}],
  ['resource contraction', ({row}) => {row('resource_limits_config').cpu_limit_parameters[1].contract_rate[1].numerator = '98';}],
  ['resource window', ({row}) => {row('resource_limits_config').account_cpu_usage_average_window++;}],
  ['row tombstone', ({table}) => {table('account').rows[0].present = 0;}],
  ['missing account row', ({table}) => {table('account').rows.pop();}],
  ['duplicate physical stream', ({deltas}) => {deltas[8] = structuredClone(deltas[7]);}],
  ['reordered streams', ({deltas}) => {[deltas[0], deltas[1]] = [deltas[1], deltas[0]];}],
  ['unexpected empty KV stream', ({deltas}) => {deltas.splice(2, 0, ['table_delta_v0', {name: 'contract_row_kv', rows: []}]);}],
];
for (const [name, mutate] of semanticMutations) test(`reject constructed ${name} despite valid encoded source`, () => {
  const value = constructed(mutate);
  assert.throws(() => verify(value));
});
for (const [field, invalid] of [['target_block_net_usage_pct', 0], ['target_block_cpu_usage_pct', 10001],
  ['max_transaction_net_usage', 10239], ['context_free_discount_net_usage_den', 0],
  ['context_free_discount_net_usage_num', 101], ['max_transaction_cpu_usage', 400000],
  ['min_transaction_cpu_usage', 399999], ['max_authority_depth', 0], ['max_action_return_value_size', 20971521],
  ['max_kv_key_size', 1025], ['max_kv_secondary_key_size', 0], ['max_kv_value_size', 1048577]]) {
  test(`reject source-invalid global configuration ${field}`, () => {
    const value = constructed(({row}) => {row('global_property').configuration[1][field] = invalid;});
    assert.throws(() => verify(value), /configuration|percentage|discount/);
  });
}
for (const [name, mutate] of [
  ['producer', block => {block.producer = 'sysio';}],
  ['header predecessor', block => {block.previous = 'a'.repeat(64);}],
  ['transaction root', block => {block.transaction_mroot = 'a'.repeat(64);}],
  ['finality root', block => {block.finality_mroot = 'a'.repeat(64);}],
  ['QC claim', block => {block.qc_claim.block_num = 1;}],
  ['header extension', block => {block.header_extensions = [{type: 0, data: ''}];}],
]) test(`reject constructed non-native ${name} even with recomputed matching ID`, () => {
  const value = constructed(({block}) => mutate(block));
  assert.throws(() => verify(value), /header/);
});

test('source identity, schema, framing, raw bounds and ordinary observation remain strict', () => {
  for (const change of [{blockNum: 2}, {previousBlockId: '0'.repeat(64)}, {chainId: 'A'.repeat(64)},
    {blockId: 'f'.repeat(64)}, {actionOrdinal: 1}]) assert.throws(() => provider.verifyNativeGenesis(original, {...fixture.source, ...change}));
  for (const traces of [undefined, new Uint8Array([0]), []]) assert.throws(() => provider.verifyNativeGenesis({...original, traces}, fixture.source));
  assert.throws(() => provider.verifyNativeGenesis({...original, schemaJson: original.schemaJson + ' '}, fixture.source), error => error.code === 'invalid_abi');
  for (const [field, value] of [['block', new Uint8Array()], ['block', new Uint8Array(1025)], ['deltas', new Uint8Array(65537)], ['schemaJson', ' '.repeat(65537)]]) {
    assert.throws(() => provider.verifyNativeGenesis({...original, [field]: value}, fixture.source));
  }
  for (const deltas of [original.deltas.subarray(0, -154), Buffer.concat([original.deltas, Buffer.from([0])]),
    Buffer.concat([Buffer.from([9]), original.deltas.subarray(1)])]) assert.throws(() => provider.verifyNativeGenesis({...original, deltas}, fixture.source));
  for (const block of [original.block.subarray(0, -1), Buffer.concat([original.block, Buffer.from([0])])]) {
    assert.throws(() => provider.verifyNativeGenesis({...original, block}, fixture.source));
  }
  assert.throws(() => createProtocolProvider('wire-sysio-7dede884-engineering-v1').verifyNativeGenesis(original, fixture.source), error => error.code === 'unsupported_feature');
  assert.throws(() => provider.observeBlockAbi({traces: undefined, accountRows: []}, {...fixture.source, blockNum: 2}));
  assert.throws(() => provider.verifyNativeGenesis({...original, get schemaJson() {throw new Error('getter must not run');}}, fixture.source), /enumerable data fields/);
  const input = {...original, block: Buffer.from(original.block), deltas: Buffer.from(original.deltas)};
  const facts = provider.verifyNativeGenesis(input, fixture.source);
  input.block.fill(0); input.deltas.fill(0);
  assert.deepEqual(facts, json('expected.json'));
});
