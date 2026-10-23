import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createWireNativeActions, createWireValueCodec, nativeActionProfileId, resolveCodecProfile, WireCodecError} from '../dist/index.js';
import {createProtocolProvider} from '../dist/provider.js';
import {nativeActionAbi} from '../dist/native-action-abi.js';
import {CODEC_LIMITS} from '../dist/codec/binary.js';
import {createNativeActionVectors, hash, loadNativeFixtures, nativeKind} from '../scripts/check-native-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = loadNativeFixtures();
const vectors = [fixtures.profile.id, nativeActionProfileId].flatMap(profileId =>
  createNativeActionVectors(fixtures, profileId).map(vector => ({...vector, id: `${profileId}: ${vector.id}`})));
const native = createWireNativeActions(fixtures.profile);
const typed = fixture => ({schemaJson: fixture.input.schemaJson,
  block: new Uint8Array(Buffer.from(fixture.input.blockHex, 'hex')),
  traces: new Uint8Array(Buffer.from(fixture.input.tracesHex, 'hex'))});
const codecError = code => error => error instanceof WireCodecError && error.code === code;

// Exercise the maintained JSON driver as well as the library. Malformed JSON
// transport cases must not be silently repaired before source validation.
const child = spawnSync(process.execPath, ['scripts/codec-driver.mjs'], {cwd: root,
  input: JSON.stringify(vectors.map(vector => vector.operation)), encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024, timeout: 180_000});
if (child.error) throw child.error;
assert.equal(child.status, 0, child.stderr);
const actual = JSON.parse(child.stdout);
assert.equal(actual.length, vectors.length, 'Every source/control must produce one driver result');
for (const [index, vector] of vectors.entries()) {
  test(`${vector.category} native action: ${vector.id}`, () => {
    assert.deepEqual(actual[index], vector.expected);
  });
}

test('private native header ABI is exactly derived from the pinned SHiP definitions', () => {
  for (const category of ['types', 'structs', 'variants']) {
    for (const entry of nativeActionAbi[category]) {
      if (category === 'structs' && entry.name === 'wire_native_onblock_v1') {
        assert.deepEqual(entry, {name: 'wire_native_onblock_v1', base: '', fields: [{name: 'header', type: 'block_header'}]});
        continue;
      }
      const key = category === 'types' ? 'new_type_name' : 'name';
      assert.deepEqual(entry, fixtures.schema[category].find(original => original[key] === entry[key]));
    }
  }
});

test('native values independently reproduce selected predecessor header IDs and original contract failures', () => {
  assert.equal(native.interfaceVersion, 1);
  for (const fixture of fixtures.cases) {
    const row = fixture.expected, bytes = Buffer.from(row.rawHex, 'hex');
    const value = native.decodeValue(nativeKind, bytes);
    assert.deepEqual(value, row.expectedValue);
    assert.equal(Buffer.from(native.encodeValue(nativeKind, value)).toString('hex'), row.rawHex);
    const height = Number.parseInt(value.header.previous.slice(0, 8), 16) + 1;
    assert.equal(height, fixture.source.blockNum - 1);
    const id = Buffer.from(hash(fixtures.codec.encode('block_header', value.header)), 'hex');
    id.writeUInt32BE(height, 0);
    assert.equal(id.toString('hex'), fixture.source.previousBlockId);
    const deployed = createWireValueCodec(fixtures.deployedAbi, fixtures.profile);
    assert.throws(() => deployed.decode('onblock', bytes), error =>
      error instanceof WireCodecError && error.code === (row.blockNum === 122 ? 'unsupported_feature' : 'invalid_value')
      && error.message === row.originalContractCodecError);
  }
  assert.equal(fixtures.cases[2].expected.expectedValue.header.new_finalizer_policy_diff.threshold, '6');
});

test('source APIs reject malformed typed framing before touching accessors or accepting extra authority', () => {
  const fixture = fixtures.cases[0], input = typed(fixture);
  assert.throws(() => native.observe({...input, get schemaJson() {throw new Error('getter must not run');}}, fixture.source),
    /enumerable data fields/);
  assert.throws(() => native.observe(input, {...fixture.source, get chainId() {throw new Error('getter must not run');}}),
    /enumerable data fields/);
  assert.throws(() => native.observe(Object.assign(Object.create({}), input), fixture.source), codecError('invalid_value'));
  assert.throws(() => native.observe(input, {...fixture.source, native: true}), codecError('invalid_value'));
  assert.throws(() => native.observe({...input, [Symbol('hidden')]: true}, fixture.source), codecError('invalid_value'));
  for (const key of ['block', 'traces']) {
    for (const value of [undefined, null, [], new Uint8Array(), Buffer.alloc(CODEC_LIMITS.maxBytes + 1)]) {
      assert.throws(() => native.observe({...input, [key]: value}, fixture.source),
        codecError(value instanceof Uint8Array && value.length > CODEC_LIMITS.maxBytes ? 'limits_exceeded' : 'invalid_value'));
    }
  }
});

test('native factory rejects every modified profile pin and both value directions reject unknown kinds', () => {
  for (const profile of [fixtures.profile, resolveCodecProfile(nativeActionProfileId)]) {
    for (const key of Object.keys(profile)) {
      const value = profile[key];
      const changed = typeof value === 'boolean' ? !value : typeof value === 'number' ? value + 1 : value + '-changed';
      assert.throws(() => createWireNativeActions({...profile, [key]: changed}), codecError('unsupported_feature'));
    }
  }
  const alternate = resolveCodecProfile('wire-sysio-7dede884-engineering-v1');
  assert.throws(() => createWireNativeActions(alternate), codecError('unsupported_feature'));
  assert.throws(() => native.decodeValue('onblock', Buffer.from(fixtures.cases[0].expected.rawHex, 'hex')), codecError('unsupported_feature'));
  assert.throws(() => native.encodeValue('onblock', fixtures.cases[0].expected.expectedValue), codecError('unsupported_feature'));
});

test('explicit native provider reproduces all original values, complete decisions and strict contract errors', () => {
  const provider = createProtocolProvider(nativeActionProfileId);
  assert.equal(provider.nativeActions.interfaceVersion, 1);
  for (const fixture of fixtures.cases) {
    assert.deepEqual(provider.nativeActions.observe(typed(fixture), fixture.source), native.observe(typed(fixture), fixture.source));
    const raw = Buffer.from(fixture.expected.rawHex, 'hex');
    assert.deepEqual(provider.nativeActions.decodeValue(nativeKind, raw), fixture.expected.expectedValue);
    assert.deepEqual(Buffer.from(provider.nativeActions.encodeValue(nativeKind, fixture.expected.expectedValue)), raw);
    assert.throws(() => provider.contractCodec.decodeValue(fixtures.deployedAbi, 'onblock', raw), error =>
      error instanceof WireCodecError && error.message === fixture.expected.originalContractCodecError);
  }
});

test('source observations preserve retained bytes and detach output from later input mutation', () => {
  const fixture = fixtures.cases[0], input = typed(fixture), source = structuredClone(fixture.source);
  const before = [hash(input.block), hash(input.traces), JSON.stringify(source)];
  const result = native.observe(input, source);
  assert.deepEqual([hash(input.block), hash(input.traces), JSON.stringify(source)], before);
  const detached = structuredClone(result);
  input.block.fill(0); input.traces.fill(0); source.blockId = 'ff'.repeat(32);
  assert.deepEqual(result, detached);
  assert.deepEqual(native.observe(typed(fixture), fixture.source), detached);
});
