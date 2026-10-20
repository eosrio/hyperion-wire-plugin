import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeAbiOracle, normalizeOracle} from './codec-oracle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = new URL('../fixtures/codec/', import.meta.url);
const files = ['oracle-vectors.json', 'crypto-vectors.json', 'source-vectors.json', 'extra-vectors.json', 'boundary-vectors.json', 'ship-vectors.json'];
const vectors = files.flatMap(file => JSON.parse(readFileSync(new URL(file, fixtureRoot))).vectors);
const abiFor = vector => vector.abi ?? (vector.abiPath ? JSON.parse(readFileSync(new URL(vector.abiPath, fixtureRoot))) : {version:'sysio::abi/1.3'});
const ops = [], checks = [];
for (const vector of vectors) {
  const abi = abiFor(vector);
  const op = {operation: vector.operation, profileId: vector.profileId, typeName: vector.typeName, hex: vector.hex, value: vector.value, abi};
  ops.push(op); checks.push({vector, abi, kind: 'golden'});
  if (!vector.operation.startsWith('decode') || Object.hasOwn(vector, 'expectedError')) continue;
  // Exhaust every truncation for metadata and small values. The complete frame
  // is compared separately; binary extensions allow some shorter valid ABIs.
  if (vector.operation === 'decodeValue' && vector.hex.length <= 240 && !['float32', 'float64'].includes(vector.typeName)) {
    for (let n = 0; n < vector.hex.length; n += 2) {
      ops.push({...op, hex: vector.hex.slice(0, n)}); checks.push({vector, abi, kind: 'mutation'});
    }
  }
  ops.push({...op, hex: vector.hex + 'aa'}); checks.push({vector, abi, kind: 'trailing'});
}
const shipAbi = JSON.parse(readFileSync(new URL('ship.abi.json', fixtureRoot)));
const delta = vectors.find(v => v.id === 'captured-ship-deltas');
ops.push({operation: 'decodeDeltas', abi: shipAbi, profileId: delta.profileId, hex: delta.hex});
checks.push({vector: delta, abi: shipAbi, kind: 'compatibility'});

function run(command, args) {
  const child = spawnSync(command, args, {cwd: root, input: JSON.stringify(ops), encoding: 'utf8', maxBuffer: 64*1024*1024, timeout: 180_000});
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
const node = run(process.execPath, ['scripts/codec-driver.mjs']);
const rust = run('cargo', ['run', '--locked', '--quiet', '--example', 'codec-driver']);
assert.equal(node.length, ops.length);
assert.equal(rust.length, ops.length);
let failures = 0;
for (let i = 0; i < checks.length; i++) {
  const {vector, abi, kind} = checks[i];
  try {
    assert.deepEqual(node[i], rust[i], `Node/Rust differ: ${vector.id} ${kind}`);
    if (kind === 'golden') {
      if (Object.hasOwn(vector, 'expectedError')) assert.deepEqual(node[i], {error:vector.expectedError});
      else if (vector.id === 'captured-ship-deltas') assert.deepEqual(node[i], {error:'invalid_value'}, 'Generic ABI codec must reject the upstream framing bug');
      else if (vector.operation.startsWith('encode')) assert.deepEqual(node[i], {result:vector.expected});
      else {
        assert.ok(Object.hasOwn(node[i], 'result'), JSON.stringify(node[i]));
        const normalize = vector.operation === 'decodeAbi' ? normalizeAbiOracle : value => normalizeOracle(value, vector.typeName, abi);
        assert.deepEqual(normalize(node[i].result), normalize(vector.expected), `Independent golden mismatch: ${vector.id}`);
      }
    } else if (kind === 'trailing') assert.ok(node[i].error, `Trailing bytes accepted: ${vector.id}`);
    else if (kind === 'compatibility') {
      assert.deepEqual(node[i].result.framing, {declaredCount:3,actualCount:4,compatibility:'wire-resource-index-count-v1'});
      assert.equal(node[i].result.deltas.at(-1)[1].name, 'resource_limits_state');
    }
  } catch (error) {
    console.error(error.message);
    if (++failures >= 10) break;
  }
}
assert.equal(failures, 0, `${failures} codec conformance mismatches`);
console.log(`Matched ${ops.length} Node/Rust operations across ${vectors.length} source-pinned fixture cases and strict malformed-input mutations.`);
