import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, writeFileSync, realpathSync, existsSync, lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = data => JSON.stringify(data, null, 2) + '\n';
const walk = path => readdirSync(join(root, path), {withFileTypes: true}).flatMap(entry => {
  const child = `${path}/${entry.name}`;
  if (entry.isSymbolicLink()) throw new Error(`Artifact source cannot be a symlink: ${child}`);
  return entry.isDirectory() ? walk(child) : [child];
});
const members = paths => [...new Set(paths)].sort().map(path => ({path, sha256: hash(readFileSync(join(root, path)))}));
const sourceFiles = members(['package.json', 'package-lock.json', 'protocol-profile.json', 'Cargo.toml', 'Cargo.lock',
  ...walk('src'), ...walk('scripts'), ...walk('crates')]);
const outputFiles = members(walk('dist').filter(path => /\.(?:js|ts|map)$/.test(path)));
const receiptPath = join(root, 'dist/protocol-source-receipt.json');
const hasOwnGitEntry = () => {
  try {lstatSync(join(root, '.git')); return true;}
  catch (error) {if (error.code === 'ENOENT') return false; throw error;}
};
const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}}).trim();
const canonical = path => {const value = realpathSync(path); return process.platform === 'win32' ? value.toLowerCase() : value;};
let sourceRevision, sourceModified, sourceOrigin;
try {
  // Never accidentally bind an unpacked dependency to a containing repository.
  if (canonical(git(['rev-parse', '--show-toplevel'])) !== canonical(root)) throw new Error('Not this package repository');
  sourceRevision = git(['rev-parse', 'HEAD']);
  sourceModified = git(['status', '--porcelain', '--untracked-files=all', '--', 'src', 'scripts', 'package.json', 'package-lock.json', 'protocol-profile.json', 'crates', 'Cargo.toml', 'Cargo.lock']).length > 0;
  sourceOrigin = 'git-checkout';
} catch (error) {
  // An existing but unreadable/corrupt Git checkout is never a clean archive.
  if (hasOwnGitEntry()) throw new Error('Cannot verify this provider Git checkout', {cause: error});
  // pacote may download the exact GitHub source archive, which has no .git.
  // Its preparation subprocess receives the resolved Git URL list in this
  // variable (pacote/lib/git.js). Accept only this package's unique exact pin.
  const pins = new Set((process.env._PACOTE_NO_PREPARE_ ?? '').split('\n').flatMap(value => {
    const match = /^(?:git\+https:\/\/github\.com\/|git\+ssh:\/\/git@github\.com\/)eosrio\/hyperion-wire-plugin(?:\.git)?#([0-9a-f]{40})$/.exec(value.trim());
    return match ? [match[1]] : [];
  }));
  if (pins.size > 1) throw new Error('Ambiguous npm-resolved provider Git pins');
  if (pins.size === 1) [sourceRevision] = pins;
  else {
    // pacote invokes prepare again while packing, without the first subprocess's
    // Git environment. Accept only a receipt produced by that first pass and
    // verify the entire source and emitted-file sets before retaining its pin.
    const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null;
    if (!receipt || receipt.schemaVersion !== 1 || receipt.sourceOrigin !== 'npm-resolved-git-archive'
        || !/^[0-9a-f]{40}$/.test(receipt.sourceRevision)
        || json(receipt.sourceFiles) !== json(sourceFiles) || json(receipt.outputFiles) !== json(outputFiles)) {
      throw new Error('Provider preparation requires an exact npm-resolved Git pin or unchanged verified source receipt');
    }
    sourceRevision = receipt.sourceRevision;
  }
  sourceModified = false;
  sourceOrigin = 'npm-resolved-git-archive';
}
if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error('An exact Git source revision is required to prepare the provider');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(receiptPath, json({schemaVersion: 1, sourceRevision, sourceOrigin, sourceFiles, outputFiles}));
// npm deliberately omits package-lock.json from tarballs. Retain its exact
// source bytes under a package member so hosts can verify this dependency pin.
writeFileSync(join(root, 'dist/protocol-npm-lock.json'), readFileSync(join(root, 'package-lock.json')));
const artifact = (id, kind, paths) => {
  const manifest = {schemaVersion: 1, id, kind, sourceRevision, sourceModified, sourceOrigin,
    files: members(paths)};
  const bytes = json(manifest);
  const runtime = id === 'wire-node-codec' ? 'node' : 'rust';
  writeFileSync(join(root, `dist/protocol-${runtime}-artifact.json`), bytes);
  return {id, runtime, version: pkg.version, sourceRevision, sha256: hash(bytes)};
};
const node = artifact('wire-node-codec', 'compiled-javascript-engineering', [
  ...walk('dist').filter(path => !/\/protocol-(?:provider|node-artifact|rust-artifact)\.json$/.test(path)),
  'package.json', 'protocol-profile.json',
]);
const rust = artifact('wire-rust-codec', 'source-only-engineering', ['Cargo.toml', 'Cargo.lock', 'protocol-profile.json', ...walk('crates')]);
const {codecProfiles, nativeActionProfileId} = await import('../dist/profiles.js');
writeFileSync(join(root, 'dist/protocol-provider.json'), json({interfaceVersion: 1,
  manifest: {schemaVersion: 1, package: pkg.name, version: pkg.version, kind: 'protocol',
    compatibility: {hyperion: '4.0.7 || >=4.5.0-0 <4.6.0', sdk: '0.0.0-dev.1'}},
  profiles: codecProfiles.map(profile => ({id: profile.id, components: [node, rust],
    ...(profile.id === nativeActionProfileId ? {nativeActions: {interfaceVersion: 1}} : {})})),
}));
if (sourceModified) console.warn('Development artifacts contain uncommitted source changes; hosts must reject them for activation.');
