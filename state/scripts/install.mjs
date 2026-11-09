#!/usr/bin/env node
// Install the built state plugin into a Hyperion checkout: <hyperion>/plugins/wire-state/{package.json, build/}.
// Only those files are copied. Hyperion hashes everything in the installed directory into the plugin's hook
// artifact, so tests or fixtures copied alongside would change the projection's identity.
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const name = 'wire-state';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target) {
    console.error('Usage: node state/scripts/install.mjs <hyperion-root>');
    process.exit(2);
}
const hyperion = resolve(target);
if (!existsSync(join(hyperion, 'package.json')) || !existsSync(join(hyperion, 'build', 'indexer'))) {
    console.error(`${hyperion} is not a built Hyperion checkout`);
    process.exit(2);
}
const build = join(source, 'build');
if (!existsSync(join(build, 'index.js'))) {
    console.error('Build the plugin first: npx tsc -p state/tsconfig.json');
    process.exit(2);
}
const plugins = join(hyperion, 'plugins'), destination = join(plugins, name), staged = join(plugins, `.${name}-staging`);
mkdirSync(plugins, {recursive: true});
rmSync(staged, {recursive: true, force: true});
mkdirSync(join(staged, 'build'), {recursive: true});
cpSync(join(source, 'package.json'), join(staged, 'package.json'));
for (const file of readdirSync(build).filter(entry => entry.endsWith('.js')).sort()) cpSync(join(build, file), join(staged, 'build', file));
rmSync(destination, {recursive: true, force: true});
renameSync(staged, destination);
// The loader also needs the plugin enabled in plugins/.state.json; other plugins keep their entries.
const statePath = join(plugins, '.state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
state.plugins = {...state.plugins, [name]: {...state.plugins?.[name], enabled: true}};
writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
console.log(`Installed ${name} into ${destination}. Enable it under "plugins" in the chain config as well.`);
