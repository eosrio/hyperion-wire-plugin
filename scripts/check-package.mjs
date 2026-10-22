import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, mkdirSync, unlinkSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve, sep} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this check through npm run test:package');
const stage = mkdtempSync(join(tmpdir(), 'hyperion-wire-package-'));
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, {cwd, encoding: 'utf8', timeout: 120_000});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
try {
  // Reproduce pacote's source-archive preparation, including the second prepare
  // with no inherited Git context. These are source/build receipts, not defaults.
  const archive = join(stage, 'source-archive');
  mkdirSync(archive);
  for (const path of ['src', 'scripts', 'crates', 'dist', 'package.json', 'package-lock.json', 'protocol-profile.json', 'Cargo.toml', 'Cargo.lock']) {
    cpSync(join(root, path), join(archive, path), {recursive: true});
  }
  const revision = JSON.parse(readFileSync(join(root, 'dist/protocol-node-artifact.json'), 'utf8')).sourceRevision;
  const archiveEnv = {...process.env, _PACOTE_NO_PREPARE_: `git+https://github.com/eosrio/hyperion-wire-plugin.git#${revision}`};
  const prepare = env => spawnSync(process.execPath, ['scripts/build-protocol-descriptor.mjs'], {cwd: archive, env, encoding: 'utf8', timeout: 30_000});
  assert.equal(prepare(archiveEnv).status, 0, 'first archive prepare requires the actual resolved pin');
  const secondEnv = {...process.env}; delete secondEnv._PACOTE_NO_PREPARE_;
  assert.equal(prepare(secondEnv).status, 0, 'second archive prepare must verify unchanged source and output receipts');
  const source = join(archive, 'src/provider.ts'); const originalSource = readFileSync(source);
  writeFileSync(source, Buffer.concat([originalSource, Buffer.from('\n// changed source\n')]));
  assert.notEqual(prepare(secondEnv).status, 0, 'a receipt must not conceal changed source');
  writeFileSync(source, originalSource);
  const output = join(archive, 'dist/provider.js'); const originalOutput = readFileSync(output);
  writeFileSync(output, Buffer.concat([originalOutput, Buffer.from('\n// changed output\n')]));
  assert.notEqual(prepare(secondEnv).status, 0, 'a receipt must not conceal changed emitted code');
  writeFileSync(output, originalOutput);
  writeFileSync(join(archive, '.git'), 'gitdir: missing-git-metadata\n');
  assert.notEqual(prepare(archiveEnv).status, 0, 'a damaged Git checkout must not downgrade to archive provenance');
  unlinkSync(join(archive, '.git'));
  try {
    symlinkSync('missing-git-metadata', join(archive, '.git'), 'file');
    assert.notEqual(prepare(archiveEnv).status, 0, 'a dangling Git entry must not downgrade to archive provenance');
    unlinkSync(join(archive, '.git'));
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    console.log('Dangling symlink setup needs Windows symlink privileges; Linux CI exercises this regression.');
  }
  const descriptor = JSON.parse(run([npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', stage]));
  // npm versions in the supported Node matrix return either an array or a name-keyed object.
  const entries = Array.isArray(descriptor) ? descriptor : Object.values(descriptor);
  assert.equal(entries.length, 1, 'Expected exactly one packed component');
  const [packed] = entries;
  assert(packed && packed.filename && packed.files?.length, 'npm pack did not return package contents');
  const paths = new Set(packed.files.map((file) => file.path));
  for (const name of ['dist/index.js', 'dist/index.d.ts', 'dist/codec/abi.js', 'dist/ship.js', 'dist/abi-observations.js', 'dist/native-genesis.js', 'dist/native-actions.js', 'dist/native-actions.d.ts', 'scripts/codec-driver.mjs', 'protocol-profile.json', 'Cargo.toml', 'Cargo.lock', 'crates/wire-protocol/src/lib.rs', 'crates/wire-protocol/src/codec/value.rs', 'crates/wire-protocol/src/codec/observations.rs', 'crates/wire-protocol/src/codec/native_actions.rs', 'crates/wire-protocol/src/codec/native_action_abi.json', 'fixtures/protocol-vectors.json', 'fixtures/codec/ship-capture.json', 'fixtures/abi-observations/vectors.json', 'fixtures/codec/native-genesis-6508-20261020/manifest.json', 'fixtures/codec/native-genesis-6508-20261020/result.bin', 'fixtures/codec/native-onblock-6508-20261022/manifest.json', 'fixtures/codec/native-onblock-6508-20261022/expected.json']) {
    assert(paths.has(name), `Missing coordinated package member: ${name}`);
  }
  assert(![...paths].some((name) => name.startsWith('node_modules/') || name.startsWith('target/')));
  writeFileSync(join(stage, 'package.json'), JSON.stringify({private: true, type: 'module'}));
  // The consumer resolves its own transitive graph, which can differ from the
  // repository lock when a dependency has published another compatible patch.
  // Cache that exact consumer lock with a normal install before proving a second
  // installation works offline. Git dependency preparation runs in both passes.
  run([npmCli, 'install', '--package-lock-only', '--allow-git=all', '--no-audit', '--no-fund', join(stage, packed.filename)], stage);
  run([npmCli, 'ci', '--allow-git=all', '--no-audit', '--no-fund'], stage);
  run([npmCli, 'ci', '--offline', '--allow-git=all', '--no-audit', '--no-fund'], stage);
  const installed = join(stage, 'node_modules', '@eosrio', 'hyperion-wire-plugin');
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).private, true);
  writeFileSync(join(stage, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import {slotToUnixMilliseconds, unixMillisecondsToSlot, normalizeKvRecord, createWireValueCodec, createWireShipCodec, createWireNativeActions, nativeActionProfileId, resolveCodecProfile, encodeWireAbi, decodeWireAbi} from '@eosrio/hyperion-wire-plugin';
import {createProtocolProvider} from '@eosrio/hyperion-wire-plugin/provider';
import descriptor from '@eosrio/hyperion-wire-plugin/protocol-provider.json' with {type: 'json'};
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import profile from '@eosrio/hyperion-wire-plugin/protocol-profile.json' with {type: 'json'};
assert.equal(slotToUnixMilliseconds(0), profile.epochMilliseconds);
assert.equal(unixMillisecondsToSlot(profile.epochMilliseconds + profile.slotMilliseconds), 1);
const source = {chainId:'a'.repeat(64),blockId:'b'.repeat(64),blockNum:1,ordinal:0,abiDeployment:'fixture:abi:1'};
const row = {kind:'contract_row_kv',present:true,code:'1',payer:'2',tableId:0,keyHex:'00ff',valueHex:'aa'};
assert.equal(normalizeKvRecord(row,source).identity, 'wire-kv-v1:row:' + source.chainId + ':1:0:00ff');
const abi = {version:'sysio::abi/1.3', structs:[{name:'row',base:'',fields:[{name:'slot',type:'block_timestamp_type'}]}]};
const codec = createWireValueCodec(decodeWireAbi(encodeWireAbi(abi)));
assert.deepEqual(codec.decode('row', new Uint8Array([0,0,0,0])), {slot:'2025-01-01T00:00:00.000'});
const installedRoot = new URL('./node_modules/@eosrio/hyperion-wire-plugin/', import.meta.url);
for (const component of descriptor.profiles[0].components) {
  const manifestBytes = readFileSync(new URL('dist/protocol-' + component.runtime + '-artifact.json', installedRoot));
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), component.sha256);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.sourceModified, false, 'packed activation requires a clean source revision');
  for (const file of manifest.files) assert.equal(createHash('sha256').update(readFileSync(new URL(file.path, installedRoot))).digest('hex'), file.sha256, file.path);
}
assert.equal(createProtocolProvider(descriptor.profiles[0].id).profileId, descriptor.profiles[0].id);
assert.equal(createProtocolProvider(descriptor.profiles[0].id).nativeActions, undefined);
for (const selected of descriptor.profiles) {
  const provider = createProtocolProvider(selected.id);
  if (selected.id === nativeActionProfileId) {
    assert.deepEqual(selected.nativeActions, {interfaceVersion: 1});
    assert.equal(provider.nativeActions.interfaceVersion, 1);
  } else {
    assert.equal(Object.hasOwn(selected, 'nativeActions'), false);
    assert.equal(Object.hasOwn(provider, 'nativeActions'), false);
  }
}
const nativeRoot = new URL('fixtures/codec/native-onblock-6508-20261022/', installedRoot);
const nativeManifest = JSON.parse(readFileSync(new URL('manifest.json', nativeRoot)));
for (const member of nativeManifest.members) {
  const bytes = readFileSync(new URL(member.path, nativeRoot));
  assert.equal(bytes.length, member.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), member.sha256);
}
const nativeSchema = readFileSync(new URL(nativeManifest.schema.path, nativeRoot));
assert.equal(createHash('sha256').update(nativeSchema).digest('hex'), nativeManifest.schema.sha256);
const nativeProfile = resolveCodecProfile(nativeActionProfileId);
const nativeShip = createWireShipCodec(JSON.parse(nativeSchema), nativeProfile);
const native = createProtocolProvider(nativeProfile.id).nativeActions;
for (const expected of JSON.parse(readFileSync(new URL('expected.json', nativeRoot)))) {
  const [, result] = nativeShip.decodeResult(readFileSync(new URL('block-' + String(expected.blockNum).padStart(6, '0') + '.bin', nativeRoot)));
  const source = {chainId:nativeManifest.chainId,blockNum:expected.blockNum,blockId:expected.blockId,previousBlockId:result.prev_block.block_id};
  const facts = native.observe({schemaJson:nativeSchema.toString('utf8'),block:Buffer.from(result.block,'hex'),traces:Buffer.from(result.traces,'hex')},source);
  assert.deepEqual(facts.decisions.find(row => row.origin.transactionId === expected.transactionId && row.origin.actionOrdinal === 1),
    {origin:{transactionId:expected.transactionId,actionOrdinal:1,rawSha256:expected.rawSha256},kind:'native',nativeKind:expected.nativeKind});
  assert.deepEqual(native.decodeValue(expected.nativeKind,Buffer.from(expected.rawHex,'hex')),expected.expectedValue);
  assert.equal(Buffer.from(native.encodeValue(expected.nativeKind,expected.expectedValue)).toString('hex'),expected.rawHex);
  assert.throws(() => createProtocolProvider(nativeProfile.id).contractCodec.decodeValue(
    decodeWireAbi(readFileSync(new URL('deployed-sysio-32.abi.bin', nativeRoot)), nativeProfile),
    'onblock', Buffer.from(expected.rawHex, 'hex')));
}
const genesisRoot = new URL('fixtures/codec/native-genesis-6508-20261020/', installedRoot);
const genesis = JSON.parse(readFileSync(new URL('manifest.json', genesisRoot)));
for (const member of genesis.members) {
  const bytes = readFileSync(new URL(member.path, genesisRoot));
  assert.equal(bytes.length, member.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), member.sha256);
}
for (const profileId of [genesis.profileId, nativeActionProfileId]) assert.deepEqual(createProtocolProvider(profileId).verifyNativeGenesis({
  schemaJson: readFileSync(new URL('ship.abi.json', genesisRoot), 'utf8'),
  block: readFileSync(new URL('block.bin', genesisRoot)), traces: null,
  deltas: readFileSync(new URL('deltas.bin', genesisRoot)),
}, genesis.source), JSON.parse(readFileSync(new URL('expected.json', genesisRoot))));
const observations = JSON.parse(readFileSync(new URL('fixtures/abi-observations/vectors.json', installedRoot)));
for (const selected of descriptor.profiles) {
  const sourceProfileId = selected.id === nativeActionProfileId ? nativeManifest.profileId : selected.id;
  const vector = observations.vectors.find(vector => vector.profileId === sourceProfileId && vector.expected?.deployments.length > 0);
  assert(vector, 'Missing packed mutation fixture');
  const input = {traces: vector.input.traces, accountRows: vector.input.accountRows.map(row => ({...row, raw: new Uint8Array(Buffer.from(row.rawHex, 'hex'))}))};
  const provider = createProtocolProvider(selected.id);
  assert.deepEqual(provider.observeBlockAbi(input, vector.source), vector.expected);
  assert.throws(() => provider.observeBlockAbi({traces: undefined, accountRows: []}, vector.source), /Missing required/);
}
`);
  run([join(stage, 'consumer.mjs')], stage);
  writeFileSync(join(stage, 'consumer.ts'), `import {slotToUnixMilliseconds, createWireNativeActions, resolveCodecProfile} from '@eosrio/hyperion-wire-plugin';\nimport type {ProtocolNativeActions} from '@eosrio/hyperion-sdk/protocol';\nconst timestamp: number = slotToUnixMilliseconds(1);\nconst native: ProtocolNativeActions = createWireNativeActions(resolveCodecProfile());\nconst bytes: Uint8Array = native.encodeValue('wire.sysio.onblock.v1', {});\nvoid [timestamp, bytes];\n`);
  const require = createRequire(import.meta.url);
  const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  run([tsc, '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', join(stage, 'consumer.ts')], stage);
  run(['scripts/run-vectors.mjs', join(installed, 'fixtures/protocol-vectors.json')]);
  const rust = spawnSync('cargo', ['test', '--locked', '--manifest-path', join(installed, 'Cargo.toml'), '--target-dir', join(stage, 'rust-target')], {cwd: installed, encoding: 'utf8', timeout: 180_000});
  if (rust.error) throw rust.error;
  assert.equal(rust.status, 0, rust.stderr || rust.stdout);
  console.log('Packed Node exports/declarations, profile, Rust source and shared fixtures passed; this private source bundle is not a qualified distribution.');
} finally {
  assert(resolve(stage).startsWith(resolve(tmpdir()) + sep) && basename(stage).startsWith('hyperion-wire-package-'));
  rmSync(stage, {recursive: true, force: true});
}
