import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = 'fixtures/protocol-vectors.json';
const run = (command, args) => {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  // The contract accepts numeric -0 as zero; canonical JSON removes its sign.
  return JSON.parse(JSON.stringify(JSON.parse(result.stdout)));
};
const expectedValues = JSON.parse(readFileSync(new URL(`../${fixture}`, import.meta.url), 'utf8')).vectors.map(
  (vector) => Object.hasOwn(vector, 'expectedError')
    ? {id: vector.id, error: vector.expectedError}
    : {id: vector.id, result: vector.expected},
);
// Compare the JSON transport representation: JSON serializes numeric -0 as 0.
const expected = JSON.parse(JSON.stringify(expectedValues));
const node = run(process.execPath, ['scripts/run-vectors.mjs', fixture]);
const rust = run('cargo', ['run', '--locked', '--quiet', '--example', 'run-vectors', '--', fixture]);
assert.deepEqual(node, expected, 'Node results differ from the shared expectations');
assert.deepEqual(rust, expected, 'Rust results differ from the shared expectations');
assert.deepEqual(node, rust, 'Node/Rust outputs diverged');
console.log(`Matched ${expected.length} source-derived engineering vectors in Node and Rust; testnet qualification remains pending.`);
