import test from 'node:test';
import assert from 'node:assert/strict';
import {balanceKey, holdersKind, resolveTokenProjectionOptions, symbolKey, tokenReducer, tokenRoutes} from '../build/index.js';
import {accountsKey, corpus, memoryState, scopedStatKey, tableInput, unscopedStatKey} from './support.mjs';

const options = resolveTokenProjectionOptions({rankedSymbols: [{contract: 'sysio.token', symbol: 'WIRE'}]});
const reduce = tokenReducer(options);
const stat = (supply, maximum = '1000.0000 TST') => tableInput('sysio.token', 'stat', scopedStatKey('TST'), true,
    {supply, max_supply: maximum, issuer: 'sysio'});
const balance = (owner, amount, present = true) => tableInput('sysio.token', 'accounts', accountsKey(owner, 'TST'), present,
    present ? {balance: amount} : null);

test('create, issue, transfer and close keep balances, holdings and supply exact', async () => {
    const state = memoryState();
    await state.apply(reduce, [stat('0.0000 TST')], 10);
    assert.equal(state.value('circulating', symbolKey('sysio.token', 'TST')).amount, '0');
    await state.apply(reduce, [stat('100.0000 TST'), balance('alice', '100.0000 TST')], 11);
    const mutations = await state.apply(reduce, [balance('alice', '60.0000 TST'), balance('bob', '40.0000 TST')], 12);
    assert.deepEqual(mutations.map(([kind, name]) => kind + ' ' + name).sort(),
        ['put balance', 'put balance', 'put holdings'], 'Each changed key is written once; unchanged supply is not rewritten');
    assert.deepEqual({...state.value('balance', balanceKey('sysio.token', 'bob', 'TST'))},
        {contract: 'sysio.token', owner: 'bob', symbol: 'TST', precision: 4, amount: '400000', block_num: 12});
    assert.deepEqual(state.value('holdings', 'bob').tokens, [{contract: 'sysio.token', symbol: 'TST'}]);
    await state.apply(reduce, [balance('bob', '0.0000 TST'), balance('alice', '100.0000 TST')], 13);
    await state.apply(reduce, [balance('bob', null, false)], 14);
    assert.equal(state.value('balance', balanceKey('sysio.token', 'bob', 'TST')), undefined);
    assert.equal(state.value('holdings', 'bob'), undefined);
    assert.equal(state.value('circulating', symbolKey('sysio.token', 'TST')).amount, '1000000');
});

test('a block whose balances no longer add up to the supply fails closed with no effects', async () => {
    const state = memoryState();
    await state.apply(reduce, [stat('100.0000 TST'), balance('alice', '100.0000 TST')], 11);
    const before = new Map(state.rows);
    await assert.rejects(state.apply(reduce, [balance('alice', '101.0000 TST')], 12), /add up to 1010000, but its supply is 1000000/);
    await assert.rejects(state.apply(reduce, [balance('carol', '1.0000 TST')], 12), /add up/);
    await assert.rejects(state.apply(reduce, [tableInput('sysio.token', 'accounts', accountsKey('dave', 'NEW'), true, {balance: '1.0000 NEW'})], 12),
        /without a stat row/);
    assert.deepEqual(state.rows, before);
});

test('unexpected rows, layouts and ABIs refuse instead of guessing', async () => {
    const state = memoryState();
    await state.apply(reduce, [stat('100.0000 TST'), balance('alice', '100.0000 TST')], 11);
    const refusals = [
        [tableInput('sysio.token', 'accounts', accountsKey('alice', 'TST'), true, {balance: '100.0000 TST'}, {abiSha256: 'f'.repeat(64)}), /no verified token key layout/],
        [tableInput('sysio.token', 'accounts', accountsKey('alice', 'TST'), true, {balance: '100.0000 OTH'}), /differs from its row key/],
        [{...balance('alice', '100.0000 TST'), identity: {kind: 'contract-row', scope: 'alice', primaryKey: '0'}}, /original KV rows/],
        [{...balance('alice', '100.0000 TST'), identity: {kind: 'kv-secondary', tableId: 1, secondaryKeyHex: '00', primaryKeyHex: '00'}}, /carries a value/],
        [tableInput('sysio.token', 'accounts', accountsKey('zed', 'TST'), false, null), /never projected/],
        [tableInput('sysio.token', 'stat', scopedStatKey('TST'), false, null), /removed a stat row/],
        [tableInput('sysio.token', 'stat', accountsKey('alice', 'TST'), true, {supply: '100.0000 TST'}), /own symbol code/],
        [tableInput('sysio.token', 'stat', scopedStatKey('TST'), true, {supply: '100.00 TST', max_supply: '1000.00 TST', issuer: 'sysio'}), /changed precision/],
        [tableInput('sysio.token', 'transfers', accountsKey('alice', 'TST'), true, {}), /Unexpected sysio.token table/],
        [tableInput('other.token', 'accounts', accountsKey('alice', 'TST'), true, {balance: '1.0000 TST'}), /Unexpected input/],
        [{...stat('2000.0000 TST'), data: {supply: '2000.0000 TST', max_supply: '1000.0000 TST', issuer: 'sysio'}}, /outside its maximum/],
    ];
    for (const [input, message] of refusals) await assert.rejects(state.apply(reduce, [input], 12), message);
});

test('unscoped LP stat rows and LP balances share the same checks', async () => {
    const state = memoryState(), lp = tokenReducer(resolveTokenProjectionOptions());
    await state.apply(lp, [tableInput('sysio.liq', 'stat', unscopedStatKey('LIQX'), true, {supply: '5.000000000 LIQX', chain_code: 'ETHEREUM'}),
        tableInput('sysio.liq', 'accounts', accountsKey('alice', 'LIQX'), true, {balance: '5.000000000 LIQX', index_checkpoint: '0', owed_wire: '0'})], 300);
    assert.equal(state.value('stat', symbolKey('sysio.liq', 'LIQX')).max_supply, undefined);
    // sysio.liq indexes stat by token: the key-only secondary row is skipped, and the primary row is the state.
    const index = tableInput('sysio.liq', 'stat', unscopedStatKey('LIQX'), true, null,
        {identity: {kind: 'kv-secondary', tableId: 11724, secondaryKeyHex: '0000000000000001', primaryKeyHex: unscopedStatKey('LIQX')}});
    assert.deepEqual(await state.apply(lp, [index], 301), []);
    assert.equal(state.value('balance', balanceKey('sysio.liq', 'alice', 'LIQX')).amount, '5000000000');
});

test('the whole captured testnet state reduces in one block and answers like the node', async () => {
    const ranked = [['sysio.token', 'WIRE'], ['sysio.token', 'SYS'], ['sysio.liq', 'LIQSOL'], ['sysio.liq', 'LIQETH'],
        ['sysio.swap', 'LIQETHP'], ['sysio.swap', 'LIQSOLP']].map(([contract, symbol]) => ({contract, symbol}));
    const all = resolveTokenProjectionOptions({rankedSymbols: ranked}), state = memoryState();
    const inputs = corpus.rows.map(row => tableInput(row.contract, row.table, row.keyHex, true, row.node.value));
    await state.apply(tokenReducer(all), inputs, corpus.capturedHeadBlock);
    const routes = tokenRoutes(all);
    const tokens = await routes.get_tokens.compose(state.reader, {route: 'get_tokens', query: {account: 'eosrio'}});
    assert.deepEqual(tokens, {account: 'eosrio', tokens: [{symbol: 'WIRE', precision: 9, amount: 75323.350694444, contract: 'sysio.token',
        balance: corpus.rows.find(row => row.node.scope === 'eosrio').node.value.balance}]});
    for (const row of corpus.rows.filter(item => item.table === 'accounts')) {
        const listed = await routes.get_tokens.compose(state.reader, {route: 'get_tokens', query: {account: row.node.scope}});
        assert.ok(listed.tokens.some(token => token.contract === row.contract && token.balance === row.node.value.balance), row.node.scope);
    }
    const holders = await routes.get_top_holders.compose(state.reader, {route: 'get_top_holders', query: {contract: 'sysio.token', symbol: 'WIRE', limit: 3}});
    const wire = corpus.rows.filter(row => row.contract === 'sysio.token' && row.table === 'accounts' && row.node.value.balance.endsWith(' WIRE'))
        .map(row => ({owner: row.node.scope, balance: row.node.value.balance, amount: BigInt(row.node.value.balance.split(' ')[0].replace('.', ''))}))
        .sort((a, b) => a.amount === b.amount ? (a.owner < b.owner ? -1 : 1) : a.amount > b.amount ? -1 : 1);
    assert.deepEqual(holders.holders.map(holder => [holder.owner, holder.balance]), wire.slice(0, 3).map(row => [row.owner, row.balance]));
    assert.equal((await state.reader.all(holdersKind('sysio.token', 'WIRE'))).length, wire.length);
});
