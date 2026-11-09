import test from 'node:test';
import assert from 'node:assert/strict';
import WireStatePlugin, {PROJECTION_ID, TOKEN_PROJECTION_LIMITS, TOP_HOLDERS_READ, resolveTokenProjectionOptions, tokenReducer,
    tokenRoutes} from '../build/index.js';
import {accountsKey, memoryState, scopedStatKey, tableInput} from './support.mjs';

const ranked = [{contract: 'sysio.token', symbol: 'WIRE'}];
const completeKind = {completeKindRead: {family: 'stateful-owner-complete-kind', interfaceVersion: 1}};
const routesContext = {interfaceVersion: 1, routes: ['get_tokens', 'get_top_holders', 'get_voters'], completeKindRead: true};

test('the plugin needs explicit enablement and validates its token configuration', () => {
    assert.throws(() => new WireStatePlugin({}), /enabled explicitly/);
    assert.throws(() => new WireStatePlugin({enabled: true, tokens: {contracts: ['other.token']}}), /no verified token ABI/);
    assert.throws(() => new WireStatePlugin({enabled: true, tokens: {rankedSymbols: [{contract: 'other.token', symbol: 'WIRE'}]}}), /configured contract/);
    assert.throws(() => new WireStatePlugin({enabled: true, tokens: {rankedSymbols: [...ranked, ...ranked]}}), /twice/);
    assert.throws(() => new WireStatePlugin({enabled: true, tokens: {verifiedAbis: {'sysio.token': ['bad']}}}), /ABI hashes/);
    const extended = new WireStatePlugin({enabled: true, tokens: {contracts: ['other.token'], verifiedAbis: {'other.token': ['a'.repeat(64)]}}});
    assert.deepEqual(extended.options.verifiedAbis, {'other.token': ['a'.repeat(64)]});
});

test('one projection selects accounts and stat of each contract, with ranked symbols as their own kinds', () => {
    const plugin = new WireStatePlugin({enabled: true, tokens: {rankedSymbols: ranked}});
    const registration = plugin.getStatefulProjectionsV2(completeKind);
    assert.equal(registration.interfaceVersion, 2); assert.equal(registration.sourceInputVersion, 2);
    const [projection] = registration.projections;
    assert.equal(projection.definition.id, PROJECTION_ID);
    assert.deepEqual(projection.definition.selectors.map(selector => selector.id),
        ['sysio.liq:accounts', 'sysio.liq:stat', 'sysio.swap:accounts', 'sysio.swap:stat', 'sysio.token:accounts', 'sysio.token:stat']);
    assert.deepEqual(projection.definition.records.map(record => record.kind),
        ['balance', 'holdings', 'stat', 'circulating', 'holders:sysio.token:WIRE']);
    assert.deepEqual(projection.limits, TOKEN_PROJECTION_LIMITS);
    assert.deepEqual(projection.requiredCompleteKindRead, {family: 'stateful-owner-complete-kind', interfaceVersion: 1, limits: TOP_HOLDERS_READ});
    for (const name of ['readAttempts', 'responseRecords', 'responseBytes']) assert.ok(TOP_HOLDERS_READ[name] <= TOKEN_PROJECTION_LIMITS[name]);
    // Without the host's complete-kind read, balances still project and only ranking is absent.
    assert.equal(plugin.getStatefulProjectionsV2({}).projections[0].requiredCompleteKindRead, undefined);
    assert.deepEqual(Object.keys(plugin.getLegacyStateRoutesV1(routesContext).routes), ['get_tokens', 'get_top_holders']);
    assert.deepEqual(Object.keys(plugin.getLegacyStateRoutesV1({...routesContext, completeKindRead: false}).routes), ['get_tokens']);
    assert.deepEqual(Object.keys(new WireStatePlugin({enabled: true}).getLegacyStateRoutesV1(routesContext).routes), ['get_tokens']);
    assert.throws(() => plugin.getLegacyStateRoutesV1({...routesContext, interfaceVersion: 2}));
});

test('top holders refuse what they cannot rank and page exactly', async () => {
    const options = resolveTokenProjectionOptions({rankedSymbols: ranked}), routes = tokenRoutes(options), state = memoryState();
    const request = query => ({route: 'get_top_holders', query});
    assert.match(routes.get_top_holders.validate(request({contract: 'eosio.token', symbol: 'WIRE'})), /projected only for/);
    assert.equal(routes.get_top_holders.validate(request({contract: 'sysio.token'})), 'symbol is required');
    assert.match(routes.get_top_holders.validate(request({contract: 'sysio.token', symbol: 'SYS'})), /not ranked/);
    assert.equal(routes.get_top_holders.validate(request({contract: 'sysio.token', symbol: 'WIRE'})), undefined);
    const balances = {alice: '5.000000000', bob: '9.000000001', carol: '5.000000000', dave: '0.000000000'};
    await state.apply(tokenReducer(options), [
        tableInput('sysio.token', 'stat', scopedStatKey('WIRE'), true, {supply: '19.000000001 WIRE', max_supply: '100.000000000 WIRE', issuer: 'sysio'}),
        ...Object.entries(balances).map(([owner, amount]) => tableInput('sysio.token', 'accounts', accountsKey(owner, 'WIRE'), true, {balance: amount + ' WIRE'}))], 7);
    const page = await routes.get_top_holders.compose(state.reader, request({contract: 'sysio.token', symbol: 'WIRE', limit: '2', skip: '1'}));
    assert.deepEqual(page, {contract: 'sysio.token', symbol: 'WIRE', holders: [
        {owner: 'alice', amount: 5, symbol: 'WIRE', updated_on: 7, balance: '5.000000000 WIRE'},
        {owner: 'carol', amount: 5, symbol: 'WIRE', updated_on: 7, balance: '5.000000000 WIRE'}]});
    const capped = await routes.get_top_holders.compose(state.reader, {...request({contract: 'sysio.token', symbol: 'WIRE', limit: 100}), configuredLimit: 1});
    assert.deepEqual(capped.holders.map(holder => holder.owner), ['bob']);
    const tokens = await routes.get_tokens.compose(state.reader, {route: 'get_tokens', query: {account: 'bob'}});
    assert.deepEqual(tokens.tokens, [{symbol: 'WIRE', precision: 9, amount: 9.000000001, contract: 'sysio.token', balance: '9.000000001 WIRE'}]);
    assert.deepEqual(await routes.get_tokens.compose(state.reader, {route: 'get_tokens', query: {account: 'nobody'}}), {account: 'nobody', tokens: []});
});
