import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const build = fileURLToPath(new URL('../build/', import.meta.url));

test('install copies only the package metadata and emitted JavaScript, and keeps other plugins enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'wire-state-install-'));
    try {
        writeFileSync(join(root, 'package.json'), '{}');
        mkdirSync(join(root, 'build', 'indexer'), {recursive: true});
        mkdirSync(join(root, 'plugins', 'wire-state', 'tests'), {recursive: true});
        writeFileSync(join(root, 'plugins', 'wire-state', 'tests', 'stale.test.mjs'), '');
        writeFileSync(join(root, 'plugins', '.state.json'), JSON.stringify({plugins: {other: {enabled: true}}}));
        execFileSync(process.execPath, [script, root], {encoding: 'utf8'});
        const installed = join(root, 'plugins', 'wire-state');
        assert.deepEqual(readdirSync(installed).sort(), ['build', 'package.json']);
        assert.deepEqual(readdirSync(join(installed, 'build')).sort(), readdirSync(build).filter(file => file.endsWith('.js')).sort());
        assert.deepEqual(JSON.parse(readFileSync(join(root, 'plugins', '.state.json'), 'utf8')).plugins,
            {other: {enabled: true}, 'wire-state': {enabled: true}});
        assert.throws(() => execFileSync(process.execPath, [script, join(root, 'missing')], {stdio: 'pipe'}));
    } finally {rmSync(root, {recursive: true, force: true});}
});
