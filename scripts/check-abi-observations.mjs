import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/abi-observations/vectors.json', import.meta.url), 'utf8'));
assert.equal(fixture.schemaVersion, 1);
assert(fixture.vectors.length > 0, 'Missing source-facts vectors');
const operations = fixture.vectors.map(vector => ({operation: 'observe_block_abi', profileId: vector.profileId,
  source: vector.source, input: vector.input}));
function run(command, args) {
  const child = spawnSync(command, args, {cwd: root, input: JSON.stringify(operations), encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024, timeout: 180_000});
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.length, operations.length);
  return result;
}
const node = run(process.execPath, ['scripts/codec-driver.mjs']);
const rust = run('cargo', ['run', '--locked', '--quiet', '--example', 'codec-driver']);
for (const [index, vector] of fixture.vectors.entries()) {
  assert.deepEqual(node[index], rust[index], `Node/Rust source facts differ: ${vector.id}`);
  assert.deepEqual(node[index], Object.hasOwn(vector, 'expectedError')
    ? {error: vector.expectedError} : {result: vector.expected}, `Independent source-facts oracle: ${vector.id}`);
}
console.log(`Matched ${operations.length} source-facts cases across both Wire engineering profiles. Canonical coverage remains a host gate.`);
