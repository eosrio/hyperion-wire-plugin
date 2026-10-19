import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}}).trim();
const sourceRevision = git(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error('An exact Git source revision is required to prepare the provider');
const sourceModified = git(['status', '--porcelain', '--untracked-files=all', '--', 'src', 'scripts', 'package.json', 'package-lock.json', 'crates', 'Cargo.toml', 'Cargo.lock']).length > 0;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = data => JSON.stringify(data, null, 2) + '\n';
// npm deliberately omits package-lock.json from tarballs. Retain its exact
// source bytes under a package member so hosts can verify this dependency pin.
writeFileSync(join(root, 'dist/protocol-npm-lock.json'), readFileSync(join(root, 'package-lock.json')));
const walk = path => readdirSync(join(root, path), {withFileTypes: true}).flatMap(entry => {
  const child = `${path}/${entry.name}`;
  if (entry.isSymbolicLink()) throw new Error(`Artifact source cannot be a symlink: ${child}`);
  return entry.isDirectory() ? walk(child) : [child];
});
const artifact = (id, kind, paths) => {
  const manifest = {schemaVersion: 1, id, kind, sourceRevision, sourceModified,
    files: [...new Set(paths)].sort().map(path => ({path, sha256: hash(readFileSync(join(root, path)))}))};
  const bytes = json(manifest);
  const runtime = id === 'wire-node-codec' ? 'node' : 'rust';
  writeFileSync(join(root, `dist/protocol-${runtime}-artifact.json`), bytes);
  return {id, runtime, version: pkg.version, sourceRevision, sha256: hash(bytes)};
};
const node = artifact('wire-node-codec', 'compiled-javascript-engineering', [
  ...walk('dist').filter(path => !/\/protocol-(?:provider|node-artifact|rust-artifact)\.json$/.test(path)),
  'package.json',
]);
const rust = artifact('wire-rust-codec', 'source-only-engineering', ['Cargo.toml', 'Cargo.lock', ...walk('crates')]);
const {codecProfiles} = await import('../dist/profiles.js');
writeFileSync(join(root, 'dist/protocol-provider.json'), json({interfaceVersion: 1,
  manifest: {schemaVersion: 1, package: pkg.name, version: pkg.version, kind: 'protocol',
    compatibility: {hyperion: '4.0.7 || >=4.5.0-0 <4.6.0', sdk: '0.0.0-dev.1'}},
  profiles: codecProfiles.map(profile => ({id: profile.id, components: [node, rust]})),
}));
if (sourceModified) console.warn('Development artifacts contain uncommitted source changes; hosts must reject them for activation.');
