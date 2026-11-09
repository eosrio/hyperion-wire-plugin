import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeScopedKey, nameFromUint64, parseAsset, formatAsset, symbolCodeFromUint64, VERIFIED_TOKEN_CONTRACTS} from '../build/index.js';
import {assetText, corpus} from './support.mjs';

test('every captured Wire row key decodes to the owner and symbol the node reports for it', () => {
    assert.equal(corpus.rows.length, 147);
    const seen = {accounts: 0, scopedStat: 0, unscopedStat: 0};
    for (const row of corpus.rows) {
        assert.deepEqual(VERIFIED_TOKEN_CONTRACTS[row.contract], [row.abiSha256], `${row.contract} ABI pin`);
        const first = assetText(row.valueHex.slice(0, 32));
        if (row.table === 'accounts') {
            const key = decodeScopedKey(row.keyHex), symbol = symbolCodeFromUint64(key.primary);
            assert.equal(nameFromUint64(key.scope), row.node.scope, row.keyHex);
            assert.equal(key.primary.toString(), String(row.node.key.sym_code ?? row.node.key.symbol_code), row.keyHex);
            assert.equal(first, row.node.value.balance, row.keyHex);
            const asset = parseAsset(row.node.value.balance);
            assert.equal(asset.symbol, symbol);
            assert.equal(formatAsset(asset.amount, asset.precision, asset.symbol), row.node.value.balance);
            seen.accounts++;
        } else {
            let symbol;
            if (row.keyHex.length === 32) {
                const key = decodeScopedKey(row.keyHex);
                assert.equal(key.scope, key.primary, 'sysio.token scopes stat by its own symbol code');
                symbol = symbolCodeFromUint64(key.primary); seen.scopedStat++;
            } else {
                assert.equal(row.keyHex.length, 16);
                symbol = symbolCodeFromUint64(BigInt('0x' + row.keyHex)); seen.unscopedStat++;
            }
            assert.equal(String(BigInt('0x' + row.keyHex.slice(-16))), String(row.node.key.sym_code ?? row.node.key.symbol_code));
            assert.equal(first, row.node.value.supply);
            assert.equal(parseAsset(first).symbol, symbol);
            if (row.node.value.max_supply) assert.equal(assetText(row.valueHex.slice(32, 64)), row.node.value.max_supply);
            if (row.node.value.issuer) assert.equal(nameFromUint64(Buffer.from(row.valueHex.slice(64, 80), 'hex').readBigUInt64LE(0)), row.node.value.issuer);
        }
    }
    assert.deepEqual(seen, {accounts: 141, scopedStat: 2, unscopedStat: 4});
});

test('balances of every captured symbol add up to its supply', () => {
    const sums = new Map(), supplies = new Map();
    for (const row of corpus.rows) {
        if (row.table === 'accounts') {
            const asset = parseAsset(row.node.value.balance), id = row.contract + ' ' + asset.symbol;
            sums.set(id, (sums.get(id) ?? 0n) + asset.amount);
        } else {
            const asset = parseAsset(row.node.value.supply);
            supplies.set(row.contract + ' ' + asset.symbol, asset.amount);
        }
    }
    assert.equal(supplies.size, 6);
    for (const [id, supply] of supplies) assert.equal(sums.get(id) ?? 0n, supply, id);
});

test('names, symbols and assets refuse malformed input', () => {
    assert.equal(nameFromUint64(0n), '');
    assert.throws(() => symbolCodeFromUint64(0n));
    assert.throws(() => symbolCodeFromUint64(0x4100000000000057n), /zero padding/);
    assert.throws(() => symbolCodeFromUint64(0x61n), /uppercase/);
    for (const key of ['e3aea9d0000000000000000045524957aa', 'E3AEA9D0000000000000000045524957', '00']) assert.throws(() => decodeScopedKey(key));
    for (const text of ['1.0WIRE', '01.0 WIRE', '-0.000 WIRE', '1.0 wire', '1 TOOLONGSYM', 1, '4611686018.427387904 WIRE'])
        assert.throws(() => parseAsset(text), String(text));
    assert.deepEqual(parseAsset('4611686018.427387903 LIQETHP'), {amount: 2n ** 62n - 1n, precision: 9, symbol: 'LIQETHP'});
    assert.deepEqual(parseAsset('7 X'), {amount: 7n, precision: 0, symbol: 'X'});
});
