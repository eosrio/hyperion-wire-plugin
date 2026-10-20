/** Offline actual-corpus qualification. No node service, broker, wallet or network request. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, relative, sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeAbiOracle, normalizeOracle} from './codec-oracle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'fixtures/codec/application-capture-20261020');
const maximum = 64 * 1024 * 1024;
const digest = data => createHash('sha256').update(data).digest('hex');

function parseExact(bytes) {
  return JSON.parse(bytes.toString('utf8'), (_key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      assert(context && /^-?\d+$/.test(context.source), 'Unsafe oracle integer requires an exact original decimal token');
      return context.source;
    }
    return value;
  });
}

function regularBytes(path, limit = maximum) {
  const info = lstatSync(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= limit, `Invalid bounded ordinary input: ${path}`);
  const bytes = readFileSync(path);
  assert(bytes.length <= limit && bytes.length === info.size, `Input changed or exceeded bound: ${path}`);
  return bytes;
}

function run(command, args, limit = maximum) {
  const child = spawnSync(command, args, {cwd: root, encoding: 'utf8', maxBuffer: limit, timeout: 180_000});
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `${command} failed: ${(child.stderr || child.stdout).slice(0, 4000)}`);
  return Buffer.from(child.stdout);
}

function normalizedAbi(value) {
  const result = normalizeAbiOracle(value);
  // Native ABI JSON omits this empty default; binary presence remains checked separately.
  for (const table of result.tables ?? []) table.secondary_indexes ??= [];
  return result;
}

function normalized(check, operation, value) {
  if (check.normalization === 'exact' || Object.hasOwn(value, 'error')) return value;
  assert.equal(check.normalization, 'official-oracle');
  return {result: normalizeOracle(value.result, operation.typeName, operation.abi)};
}

function sourceHashes() {
  const files = ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'protocol-profile.json',
    'scripts/codec-driver.mjs', 'scripts/codec-oracle.mjs', 'scripts/check-application-capture.mjs',
    'fixtures/codec/application-capture-20261020/manifest.json',
    'fixtures/codec/application-capture-20261020/audit.py', 'fixtures/codec/application-capture-20261020/prepare.py',
    'tests/test_application_capture_audit.py',
    'fixtures/codec/application-capture-20261020/raw-capture.tar.gz',
    'fixtures/codec/application-capture-20261020/official-row-oracles.tar.gz'];
  let total = 0;
  function walk(path) {
    assert(files.length < 4000, 'Source file-count limit');
    for (const entry of readdirSync(join(root, path), {withFileTypes: true})) {
      const child = join(path, entry.name);
      assert(!entry.isSymbolicLink(), `Source symlink refused: ${child}`);
      if (entry.isDirectory()) walk(child);
      else {assert(entry.isFile(), `Special source entry refused: ${child}`); assert(files.length < 4000, 'Source file-count limit'); files.push(child);}
    }
  }
  for (const path of ['src', 'dist', 'crates']) walk(path);
  return Object.fromEntries(files.sort().map(path => {
    const data = regularBytes(join(root, path)); total += data.length;
    assert(total <= 128 * 1024 * 1024, 'Source evidence byte limit');
    return [path.split(sep).join('/'), digest(data)];
  }));
}

assert.equal(process.release.name, 'node', 'Run actual corpus checks under the supported Node runtime');
assert(!process.versions.bun, 'Bun is the checker toolchain, not an implicitly qualified codec runtime');
const sourcesBefore = sourceHashes();
const temporaryRoot = realpathSync(tmpdir());
const stage = mkdtempSync(join(temporaryRoot, 'hyperion-wire-application-'));
const owner = randomUUID();
writeFileSync(join(stage, '.owner.json'), JSON.stringify({owner}), {flag: 'wx'});
try {
  const output = join(stage, 'prepared');
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const preparationBytes = run(python, ['-B', join(fixture, 'prepare.py'), output], 1024 * 1024);
  const preparation = parseExact(preparationBytes);
  assert.equal(preparation.status, 'prepared');
  assert.equal(preparation.operations, 1267);
  const derived = join(output, 'derived');
  const load = name => {
    const bytes = regularBytes(join(derived, name));
    assert.equal(bytes.length, preparation.files[name].bytes);
    assert.equal(digest(bytes), preparation.files[name].sha256);
    return parseExact(bytes);
  };
  const operations = load('operations.json');
  const checks = load('checks.json');
  const audit = load('audit.json');
  const supplemental = load('supplement.json');
  assert.equal(operations.length, checks.length);
  assert.equal(supplemental.rowOperations, 627);
  assert.equal(supplemental.abiOperations, 8);
  assert.equal(supplemental.officialCommands, 342);
  const nodeBytes = run(process.execPath, ['scripts/codec-driver.mjs', join(derived, 'operations.json')]);
  const rustVersion = run('rustc', ['--version'], 4096).toString('utf8').trim();
  const rustBytes = run('cargo', ['run', '--locked', '--quiet', '--example', 'codec-driver', '--', join(derived, 'operations.json')]);
  const node = parseExact(nodeBytes), rust = parseExact(rustBytes);
  assert.equal(node.length, operations.length); assert.equal(rust.length, operations.length);
  const linked = new Map();
  for (const observation of supplemental.links) {
    assert(!linked.has(observation.index), 'Duplicate supplemental operation');
    linked.set(observation.index, observation);
  }
  let originalExpectations = 0, officialRows = 0, officialAbis = 0, independentOperations = 0;
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index], check = checks[index];
    assert.equal(check.index, index);
    assert.deepEqual(node[index], rust[index], `Node/Rust mismatch: ${check.id}`);
    assert(node[index] && typeof node[index] === 'object' && Object.keys(node[index]).length === 1
      && (Object.hasOwn(node[index], 'result') || Object.hasOwn(node[index], 'error')), `Malformed codec output: ${check.id}`);
    let independentlyChecked = false;
    if (Object.hasOwn(check, 'expected')) {
      assert.deepEqual(normalized(check, operation, node[index]), normalized(check, operation, check.expected), `Original independent expectation mismatch: ${check.id}`);
      originalExpectations++; independentlyChecked = true;
    } else assert.equal(check.normalization, 'parity-only');
    const observation = linked.get(index);
    if (observation) {
      assert.equal(digest(Buffer.from(operation.hex, 'hex')), observation.rawSha256, `Supplemental raw binding mismatch: ${check.id}`);
      assert(Object.hasOwn(node[index], 'result'), `Actual raw input failed decoding: ${check.id}`);
      if (observation.kind === 'abi') {
        assert.equal(operation.operation, 'decodeAbi'); assert.equal(observation.typeName, null);
        assert.deepEqual(normalizedAbi(node[index].result), normalizedAbi(observation.expected), `Native ABI semantic oracle mismatch: ${check.id}`);
        officialAbis++;
      } else {
        assert.equal(observation.kind, 'row'); assert.equal(operation.operation, 'decodeValue');
        assert.equal(operation.typeName, observation.typeName);
        assert.deepEqual(normalizeOracle(node[index].result, operation.typeName, operation.abi),
          normalizeOracle(observation.expected, operation.typeName, operation.abi), `Typed official row oracle mismatch: ${check.id}`);
        officialRows++;
      }
      independentlyChecked = true;
    }
    assert(independentlyChecked, `Parity without independent evidence is not qualification: ${check.id}`);
    independentOperations++;
  }
  assert.equal(originalExpectations, 812);
  assert.equal(officialRows, 627); assert.equal(officialAbis, 8);
  assert.equal(independentOperations, 1267);
  assert.deepEqual(sourceHashes(), sourcesBefore, 'Qualification source files changed during the check');
  console.log(JSON.stringify({schemaVersion: 1, status: 'passed', scope: 'retained-7d-engineering-corpus-only',
    runtime: {node: process.version, rust: rustVersion}, operations: operations.length,
    independentOperations, originalExpectations, officialRows, officialAbis, parityOnly: 0,
    blocks: audit.blockCount, transactions: audit.transactionCount, actionReceipts: audit.actionReceiptCount,
    physicalRows: audit.physicalDeltaRows, operationsSha256: preparation.files['operations.json'].sha256,
    checksSha256: preparation.files['checks.json'].sha256, supplementSha256: preparation.files['supplement.json'].sha256,
    nodeResultsSha256: digest(nodeBytes), rustResultsSha256: digest(rustBytes), sourceHashes: sourcesBefore,
    limits: audit.limits}));
} finally {
  const actual = realpathSync(stage);
  assert(lstatSync(stage).isDirectory() && !lstatSync(stage).isSymbolicLink());
  assert.equal(dirname(actual), temporaryRoot);
  assert(basename(actual).startsWith('hyperion-wire-application-') && relative(temporaryRoot, actual) === basename(actual));
  assert.equal(parseExact(regularBytes(join(stage, '.owner.json'), 1024)).owner, owner);
  rmSync(actual, {recursive: true, force: false});
}
