import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {deflateSync} from 'node:zlib';
import {createWireValueCodec, decodeWireAbi, nativeActionProfileId, resolveCodecProfile} from '../dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = new URL('../fixtures/codec/native-onblock-6508-20261022/', import.meta.url);
export const nativeKind = 'wire.sysio.onblock.v1';
export const profileId = 'wire-sysio-6508c9e8-engineering-v1';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = bytes => Buffer.from(bytes).toString('hex');
const unhex = text => Buffer.from(text, 'hex');
const read = name => readFileSync(new URL(name, fixtureRoot));
const readJson = name => JSON.parse(read(name));

// These pins are independent of the retained manifest's own assertions. No
// source-verifier result is used to generate the original expected decisions.
const originalPins = [
  [33, 'a3941b1cb2e85155cd60335a41fcf8b54dbd9d4498b815e548ba5f63734b8df8', 'da05e1d7e9099dd5340b7533da31d92e988303b76869a085633d1fec0a6177e6'],
  [122, '30a6dedcf42e682ac47d1f19f8bf34f843485dd23b06734192a10e2e131b1b89', '7a1e20b6e3ee9d0a98a69858c70cd0dc18c95fcf406faccbc2b8a4b46511d9c2'],
  [397, '6465f29d04ea8013692623bf318f5e49af8e2c6619f57475cad7fc0c9ed60875', '267d406b908f6674dfcbfba343364967965408967d761a13dfae51a30b5cd7e7'],
];

/** Immutable original frames, matching official-clio values, and their pins. */
export function loadNativeFixtures() {
  const manifest = readJson('manifest.json');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.profileId, profileId);
  assert.equal(manifest.upstreamRevision, '6508c9e8f4044df8d5acb082a7af3be6a80cd9a0');
  assert.equal(manifest.chainId, '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d');
  assert.equal(manifest.originalArchiveSha256, '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
  assert.equal(manifest.originalManifestSha256, 'fa48079240a25d6fddfe80b83539bf0735be0f03b034dd816205c7e815d2d305');
  assert.equal(manifest.members.length, 13);
  for (const member of manifest.members) {
    const bytes = read(member.path);
    assert.equal(bytes.length, member.bytes, member.path);
    assert.equal(hash(bytes), member.sha256, member.path);
  }
  const schemaJson = read(manifest.schema.path).toString('utf8');
  assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
  const schema = JSON.parse(schemaJson), profile = resolveCodecProfile(profileId);
  const codec = createWireValueCodec(schema, profile);
  const expected = readJson('expected.json');
  assert.deepEqual(expected.map(row => [row.blockNum, row.transactionId, row.rawSha256]), originalPins);
  const deployedAbi = decodeWireAbi(read('deployed-sysio-32.abi.bin'), profile);
  const cases = expected.map(row => {
    const [, frame] = codec.decode('result', read(`block-${String(row.blockNum).padStart(6, '0')}.bin`));
    const input = {schemaJson, blockHex: frame.block, tracesHex: frame.traces};
    const source = {chainId: manifest.chainId, blockNum: row.blockNum, blockId: row.blockId,
      previousBlockId: frame.prev_block.block_id};
    const block = codec.decode('signed_block', unhex(frame.block));
    const traces = codec.decode('transaction_trace[]', unhex(frame.traces));
    assert.equal(frame.this_block.block_id, row.blockId);
    assert.equal(traces[0][1].id, row.transactionId);
    assert.equal(traces[0][1].action_traces[0][1].act.data, row.rawHex);
    assert.equal(hash(unhex(row.rawHex)), row.rawSha256);
    const [, previous] = codec.decode('result', read(`block-${String(row.blockNum - 1).padStart(6, '0')}.bin`));
    assert(previous.block.startsWith(row.rawHex), 'Original payload must be the previous raw block header prefix');
    assert.equal(previous.this_block.block_id, source.previousBlockId);
    return {input, source, block, traces, expected: row};
  });
  return {manifest, schemaJson, schema, profile, codec, deployedAbi, cases};
}

const unsigned = (action, expiration = '1970-01-01T00:00:00') => ({expiration, ref_block_num: 0,
  ref_block_prefix: 0, max_net_usage_words: 0, max_cpu_usage_ms: 0, delay_sec: 0,
  context_free_actions: [], actions: [structuredClone(action)], transaction_extensions: []});
const packed = (bytes, compression = 0) => ({cpu_usage_us: [0], trx: {signatures: [], compression,
  packed_context_free_data: '', packed_trx: hex(bytes)}});
const firstAction = fixture => fixture.traces[0][1].action_traces[0][1];

// Constructed controls preserve the selected current header but edit source
// bodies. They test rejection and occurrence boundaries, not node acceptance.
function constructed(fixture, codec) {
  fixture.input.blockHex = hex(codec.encode('signed_block', fixture.block));
  fixture.input.tracesHex = hex(codec.encode('transaction_trace[]', fixture.traces));
}
function addUser(fixture, codec) {
  const user = structuredClone(fixture.traces[0]);
  const action = user[1].action_traces[0][1];
  action.receipt[1].global_sequence = (BigInt(fixture.expected.globalSequence) + 1n).toString();
  const raw = codec.encode('transaction', unsigned(action.act, '2030-01-01T00:00:00'));
  user[1].id = hash(raw);
  user[1].partial[1].expiration = '2030-01-01T00:00:00';
  fixture.traces.push(user);
  fixture.block.transactions.push(packed(raw));
  return Buffer.from(raw);
}
function addChild(fixture, receiver = 'sysio', creator = 1) {
  const child = structuredClone(fixture.traces[0][1].action_traces[0]);
  child[1].action_ordinal = 2;
  child[1].creator_action_ordinal = creator;
  child[1].receiver = receiver;
  child[1].receipt[1].receiver = receiver;
  child[1].receipt[1].global_sequence = (BigInt(fixture.expected.globalSequence) + 1n).toString();
  fixture.traces[0][1].action_traces.push(child);
  return child[1];
}

const errors = {
  native_source_invalid: 'Native onblock source verification failed',
  native_source_limits: 'Native onblock source exceeds verification limits',
  native_source_unsupported: 'Unsupported native onblock source semantics',
};
function expectedFacts(fixture, candidate = 'native') {
  const selectedTransaction = fixture.traces[0][1];
  const selectedAction = firstAction(fixture);
  const rows = fixture.traces.flatMap(([, trx]) => trx.action_traces
    .map(([, action]) => ({transactionId: trx.id, action}))
    .filter(({action}) => action.receiver === action.act.account));
  rows.sort((left, right) => BigInt(left.action.receipt[1].global_sequence) < BigInt(right.action.receipt[1].global_sequence) ? -1 : 1);
  return {schemaVersion: 1, decisions: rows.map(({transactionId, action}) => {
    const origin = {transactionId, actionOrdinal: action.action_ordinal, rawSha256: hash(unhex(action.act.data))};
    if (transactionId !== selectedTransaction.id || action.action_ordinal !== selectedAction.action_ordinal) {
      return {origin, kind: 'contract'};
    }
    return candidate === 'native' ? {origin, kind: 'native', nativeKind}
      : {origin, kind: 'incomplete', error: {code: candidate, message: errors[candidate]}};
  })};
}

/** Deterministic common corpus. Expectations come from retained or constructed
 * source facts; neither implementation supplies the other's oracle. */
export function createNativeActionVectors(fixtures = loadNativeFixtures(), selectedProfileId = profileId) {
  const {codec, cases, deployedAbi} = fixtures;
  const vectors = [];
  const push = (id, operation, expected, category = 'constructed') => vectors.push({id, category,
    operation: {profileId: selectedProfileId, ...operation}, expected});
  const observe = (id, fixture, candidate = 'native', globalError) => push(id,
    {operation: 'observe_native_actions', input: fixture.input, source: fixture.source},
    globalError ? {error: globalError} : {result: expectedFacts(fixture, candidate)});
  const mutate = (id, edit, candidate = 'native_source_invalid', globalError) => {
    const fixture = structuredClone(cases[0]);
    edit(fixture);
    constructed(fixture, codec);
    observe(id, fixture, candidate, globalError);
  };

  for (const fixture of cases) {
    const row = fixture.expected;
    push(`original-${row.blockNum}-observe`, {operation: 'observe_native_actions', input: fixture.input,
      source: fixture.source}, {result: {schemaVersion: 1, decisions: [{origin: {transactionId: row.transactionId,
        actionOrdinal: row.actionOrdinal, rawSha256: row.rawSha256}, kind: 'native', nativeKind}]}}, 'original');
    push(`original-${row.blockNum}-decode`, {operation: 'decode_native_value', nativeKind, hex: row.rawHex},
      {result: row.expectedValue}, 'original');
    push(`original-${row.blockNum}-encode`, {operation: 'encode_native_value', nativeKind, value: row.expectedValue},
      {result: row.rawHex}, 'original');
    push(`original-${row.blockNum}-deployed-abi-remains-strict`, {operation: 'decodeValue', abi: deployedAbi,
      typeName: 'onblock', hex: row.rawHex}, {error: row.blockNum === 122 ? 'unsupported_feature' : 'invalid_value'}, 'original');
    for (const [name, bytes] of [['appended', row.rawHex + '00'], ['truncated', row.rawHex.slice(0, -2)],
      ['noncanonical-header-varuint', row.rawHex.slice(0, -2) + '8000']]) {
      push(`${row.blockNum}-native-${name}`, {operation: 'decode_native_value', nativeKind, hex: bytes}, {error: 'invalid_value'});
    }
  }
  const original = cases[0];
  const simpleOperation = {operation: 'observe_native_actions', input: original.input, source: original.source};
  for (const [name, edit] of [
    ['unknown-kind-decode', () => ({operation: 'decode_native_value', hex: original.expected.rawHex, nativeKind: 'onblock'})],
    ['unknown-kind-encode', () => ({operation: 'encode_native_value', value: original.expected.expectedValue, nativeKind: 'onblock'})],
    ['old-profile', op => ({...op, profileId: 'wire-sysio-7dede884-engineering-v1'})],
    ['unknown-profile', op => ({...op, profileId: 'wire-unknown'})],
  ]) push(name, edit(simpleOperation), {error: 'unsupported_feature'});
  push('missing-native-header', {operation: 'encode_native_value', nativeKind, value: {header: {}}}, {error: 'invalid_value'});
  push('extra-native-field', {operation: 'encode_native_value', nativeKind,
    value: {...original.expected.expectedValue, extra: true}}, {error: 'invalid_value'});

  mutate('same-name-identical-user-action', fixture => {addUser(fixture, codec);}, 'native');
  mutate('same-name-identical-inline-action', fixture => {addChild(fixture);}, 'native');
  mutate('notification-is-not-a-second-input', fixture => {addChild(fixture, 'alice');}, 'native');
  mutate('extra-root-isolated-from-other-contract-input', fixture => {addChild(fixture, 'sysio', 0);});
  mutate('first-source-user-does-not-promote-later-onblock', fixture => {
    addUser(fixture, codec); fixture.traces.reverse();
  });
  mutate('source-supported-action-trace-v0', fixture => {
    const action = fixture.traces[0][1].action_traces[0];
    action[0] = 'action_trace_v0'; delete action[1].return_value;
  }, 'native');

  const localEdits = [
    ['partial-reference', fixture => {fixture.traces[0][1].partial[1].ref_block_num = 1;}],
    ['partial-expiration', fixture => {fixture.traces[0][1].partial[1].expiration = '2030-01-01T00:00:00';}],
    ['partial-context-free-data', fixture => {fixture.traces[0][1].partial[1].context_free_data = ['00'];}],
    ['partial-absent', fixture => {fixture.traces[0][1].partial = null;}],
    ['authorization-actor', fixture => {firstAction(fixture).act.authorization[0].actor = 'alice';}],
    ['authorization-permission', fixture => {firstAction(fixture).act.authorization[0].permission = 'owner';}],
    ['authorization-empty', fixture => {firstAction(fixture).act.authorization = [];}],
    ['transaction-id', fixture => {fixture.traces[0][1].id = '11'.repeat(32);}],
    ['payload-appended', fixture => {firstAction(fixture).act.data += '00';}],
    ['payload-truncated', fixture => {firstAction(fixture).act.data = firstAction(fixture).act.data.slice(0, -2);}],
    ['payload-other-header', fixture => {
      const header = structuredClone(fixture.expected.expectedValue.header);
      header.transaction_mroot = '11'.repeat(32);
      firstAction(fixture).act.data = hex(codec.encode('block_header', header));
    }],
    ['action-name', fixture => {firstAction(fixture).act.name = 'other';}],
    ['context-free-root', fixture => {firstAction(fixture).context_free = 1;}],
    ['root-ordinal', fixture => {firstAction(fixture).action_ordinal = 2;}],
  ];
  for (const [name, edit] of localEdits) mutate(`isolated-${name}`, fixture => {
    addUser(fixture, codec); edit(fixture);
  });

  for (const key of ['chainId', 'blockNum', 'blockId', 'previousBlockId']) {
    for (const change of ['missing', 'null']) {
      const fixture = structuredClone(original);
      if (change === 'missing') delete fixture.source[key]; else fixture.source[key] = null;
      observe(`source-${key}-${change}`, fixture, undefined, 'invalid_value');
    }
  }
  for (const [key, value] of [['blockNum', 34], ['blockNum', 1], ['blockNum', 0x1_0000_0000],
    ['blockId', '11'.repeat(32)], ['previousBlockId', '11'.repeat(32)], ['chainId', 'AA'.repeat(32)], ['extra', true]]) {
    const fixture = structuredClone(original); fixture.source[key] = value;
    observe(`source-${key}-${String(value).slice(0, 16)}`, fixture, undefined, 'invalid_value');
  }
  // A different syntactically valid chainId cannot be inferred from a block
  // header. Canonical chain/source binding remains the host's responsibility.
  for (const [name, edit, error] of [
    ['schema-foreign', input => {input.schemaJson += ' ';}, 'invalid_abi'],
    ['schema-oversized', input => {input.schemaJson = ' '.repeat(65537);}, 'limits_exceeded'],
    ['schema-null', input => {input.schemaJson = null;}, 'invalid_value'],
    ['input-extra-key', input => {input.extra = true;}, 'invalid_value'],
  ]) {
    const fixture = structuredClone(original); edit(fixture.input);
    observe(name, fixture, undefined, error);
  }
  {
    // Constructed malformed framing, not an accepted large block: binary input
    // remains below16MiB even though its JSON hex transport exceeds16MiB text.
    const fixture = structuredClone(original), padded = Buffer.alloc(8 * 1024 * 1024 + 1);
    unhex(fixture.input.blockHex).copy(padded);
    fixture.input.blockHex = hex(padded);
    observe('padded-current-block-under-binary-limit', fixture, undefined, 'invalid_value');
  }
  for (const key of ['blockHex', 'tracesHex']) {
    for (const [name, edit] of [['missing', input => {delete input[key];}], ['null', input => {input[key] = null;}],
      ['empty', input => {input[key] = '';}], ['appended', input => {input[key] += '00';}],
      ['truncated', input => {input[key] = input[key].slice(0, -2);}], ['odd-hex', input => {input[key] = '0';}],
      ['invalid-hex', input => {input[key] = 'gg';}]]) {
      const fixture = structuredClone(original); edit(fixture.input);
      observe(`${key}-${name}`, fixture, undefined, 'invalid_value');
    }
    const fixture = structuredClone(original); fixture.input[key] = fixture.input[key].toUpperCase();
    observe(`${key}-equivalent-uppercase-hex`, fixture);
  }

  for (const [name, edit, error] of [
    ['empty-transactions', fixture => {fixture.traces = [];}, 'invalid_value'],
    ['missing-receipt', fixture => {firstAction(fixture).receipt = null;}, 'invalid_value'],
    ['receipt-receiver', fixture => {firstAction(fixture).receipt[1].receiver = 'alice';}, 'invalid_value'],
    ['uncommitted-transaction', fixture => {fixture.traces[0][1].status = 1;}, 'unsupported_feature'],
    ['scheduled-transaction', fixture => {fixture.traces[0][1].scheduled = 1;}, 'unsupported_feature'],
    ['failed-action', fixture => {firstAction(fixture).except = 'constructed failure';}, 'invalid_value'],
    ['duplicate-transaction', fixture => {fixture.traces.push(structuredClone(fixture.traces[0]));}, 'invalid_value'],
    ['duplicate-action-ordinal', fixture => {addChild(fixture).action_ordinal = 1;}, 'invalid_value'],
    ['duplicate-global-sequence', fixture => {addChild(fixture).receipt[1].global_sequence = fixture.expected.globalSequence;}, 'invalid_value'],
    ['unresolved-notification', fixture => {addChild(fixture, 'alice').act.data += '00';}, 'invalid_value'],
  ]) mutate(`origin-${name}`, edit, undefined, error);

  for (const compression of [0, 1]) mutate(`contradictory-implicit-packed-membership-${compression}`, fixture => {
    const bytes = codec.encode('transaction', unsigned(firstAction(fixture).act));
    fixture.block.transactions.push(packed(compression ? deflateSync(bytes) : bytes, compression));
  });
  for (const mode of ['valid', 'unknown', 'truncated', 'trailing', 'noncanonical', 'duplicate', 'extra-transaction-bytes']) {
    mutate(`compressed-user-${mode}`, fixture => {
      let raw = addUser(fixture, codec);
      if (mode === 'noncanonical') {
        assert.equal(raw[13], 0, 'Expected empty context-free action count after the 13-byte transaction header');
        raw = Buffer.concat([raw.subarray(0, 13), Buffer.from([0x80, 0]), raw.subarray(14)]);
      }
      if (mode === 'extra-transaction-bytes') raw = Buffer.concat([raw, Buffer.from([0])]);
      let bytes = deflateSync(raw);
      if (mode === 'truncated') bytes = bytes.subarray(0, -1);
      if (mode === 'trailing') bytes = Buffer.concat([bytes, Buffer.from([0])]);
      fixture.block.transactions[0] = packed(bytes, mode === 'unknown' ? 2 : 1);
      if (mode === 'duplicate') fixture.block.transactions.push(structuredClone(fixture.block.transactions[0]));
    }, mode === 'valid' ? 'native' : mode === 'unknown' ? 'native_source_unsupported' : 'native_source_invalid');
  }
  mutate('compressed-single-transaction-10MiB-budget', fixture => {
    addUser(fixture, codec);
    fixture.block.transactions[0] = packed(deflateSync(Buffer.alloc(10 * 1024 * 1024 + 1)), 1);
  }, 'native_source_limits');
  mutate('compressed-aggregate-membership-16MiB-budget', fixture => {
    addUser(fixture, codec);
    fixture.block.transactions = [];
    for (let index = 0; index < 3; index++) {
      const transaction = unsigned(firstAction(fixture).act, '2030-01-01T00:00:00');
      transaction.ref_block_prefix = index;
      transaction.actions[0].data = '';
      const prefix = Buffer.from(codec.encode('transaction', transaction));
      assert.equal(hex(prefix.subarray(-2)), '0000', 'Audited empty action bytes and extension vector');
      // Exact canonical varuint(6MiB), independently assembled to keep fixture
      // generation bounded. Each transaction fits 10MiB; the total exceeds16MiB.
      const size = 6 * 1024 * 1024;
      const raw = Buffer.concat([prefix.subarray(0, -2), Buffer.from([0x80, 0x80, 0x80, 3]),
        Buffer.alloc(size), prefix.subarray(-1)]);
      assert(raw.length < 10 * 1024 * 1024);
      fixture.block.transactions.push(packed(deflateSync(raw), 1));
    }
  }, 'native_source_limits');
  assert.equal(new Set(vectors.map(vector => vector.id)).size, vectors.length, 'Unique control names');
  return vectors;
}

function runDriver(command, args, operations) {
  const child = spawnSync(command, args, {cwd: root, input: JSON.stringify(operations), encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024, timeout: 180_000});
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `${command}: ${child.stderr}`);
  const results = JSON.parse(child.stdout);
  assert.equal(results.length, operations.length, 'Complete driver response');
  return results;
}

export function checkNativeActionParity({rustDriver} = {}) {
  const fixtures = loadNativeFixtures();
  const vectors = [profileId, nativeActionProfileId].flatMap(selected =>
    createNativeActionVectors(fixtures, selected).map(vector => ({...vector, id: `${selected}: ${vector.id}`})));
  const operations = vectors.map(vector => vector.operation);
  const node = runDriver(process.execPath, ['scripts/codec-driver.mjs'], operations);
  const rust = rustDriver ? runDriver(resolve(root, rustDriver), [], operations)
    : runDriver('cargo', ['run', '--locked', '--quiet', '--example', 'codec-driver'], operations);
  for (const [index, vector] of vectors.entries()) {
    assert.deepEqual(node[index], vector.expected, `Independent Node native-source oracle: ${vector.id}`);
    assert.deepEqual(rust[index], vector.expected, `Independent Rust native-source oracle: ${vector.id}`);
    assert.deepEqual(node[index], rust[index], `Node/Rust native source differs: ${vector.id}`);
  }
  console.log(`Matched ${vectors.length} native-action controls (${vectors.filter(vector => vector.category === 'original').length} original-source operations) across Node/Rust. Canonical host authority and deployment remain separate gates.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 2 && args[0] === '--rust-driver' && args[1]),
    'Usage: node scripts/check-native-actions.mjs [--rust-driver path]');
  checkNativeActionParity({rustDriver: args[1]});
}
