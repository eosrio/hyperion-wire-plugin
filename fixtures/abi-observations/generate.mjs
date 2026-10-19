// Synthetic transport construction with a manual facts oracle. Never import the observer here.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {codecProfiles, createWireValueCodec, encodeWireAbi} from '../../dist/index.js';

const hex = bytes => Buffer.from(bytes).toString('hex');
const copy = value => structuredClone(value);
const transactionId = 'd'.repeat(64), otherTransactionId = 'e'.repeat(64);
const source = {chainId: 'a'.repeat(64), blockId: '000001f4' + 'b'.repeat(56),
  previousBlockId: '000001f3' + 'c'.repeat(56), blockNum: 500};
const accountTimestamp = '2025-01-01T00:00:00.000';
const transportAbi = JSON.parse(await readFile(new URL('../codec/ship.abi.json', import.meta.url), 'utf8'));
const abiMetadata = field => ({version: 'sysio::abi/1.3', structs: [
  {name: 'sample', base: '', fields: [{name: field, type: 'uint32'}]}],
  actions: [{name: 'put', type: 'sample', ricardian_contract: ''}]});
const varuint = value => {
  const bytes = [];
  do {const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0));} while (value);
  return hex(bytes);
};
const spec = (ordinal, globalSequence, changes = {}) => ({
  ordinal, globalSequence: String(globalSequence), creator: 0, receiver: 'target', account: 'target',
  name: 'put', rawHex: '07000000', authorization: [{actor: 'target', permission: 'active'}],
  receiptAbiSequence: '3', contextFree: false, ...changes,
});
const actionTrace = action => ['action_trace_v1', {
  action_ordinal: action.ordinal, creator_action_ordinal: action.creator,
  receipt: ['action_receipt_v0', {receiver: action.receiver, act_digest: '1'.repeat(64),
    global_sequence: action.globalSequence, recv_sequence: '1', auth_sequence: [],
    code_sequence: 0, abi_sequence: Number(action.receiptAbiSequence)}],
  receiver: action.receiver, act: {account: action.account, name: action.name,
    authorization: copy(action.authorization), data: action.rawHex},
  context_free: action.contextFree, elapsed: '0', console: '', account_ram_deltas: [],
  except: null, error_code: null, return_value: '',
}];
const transaction = (actions, id = transactionId) => ['transaction_trace_v0', {
  id, status: 0, cpu_usage_us: 1, net_usage_words: 0, elapsed: '0', net_usage: '0',
  scheduled: false, action_traces: actions.map(actionTrace), account_ram_delta: null,
  except: null, error_code: null, failed_dtrx_trace: null, partial: null,
}];
// Expected ordering and input origins are explicit call-site arguments, not observer inference.
const fact = (action, inputActionOrdinal = action.ordinal, id = transactionId) => ({
  transactionId: id, actionOrdinal: action.ordinal, receiver: action.receiver,
  account: action.account, name: action.name, rawHex: action.rawHex,
  globalSequence: action.globalSequence, receiptAbiSequence: action.receiptAbiSequence,
  inputActionOrdinal,
});
const deployment = (action, account, abiHex, id = transactionId) => ({
  account, abiHex, action: {transactionId: id, actionOrdinal: action.ordinal},
  globalSequence: action.globalSequence, effect: 'native-before-receipt',
});
const emptyFacts = () => ({schemaVersion: 1, actionInputs: [], deployments: [], finalStates: []});
const vectors = [];
for (const profile of codecProfiles) {
  const transport = createWireValueCodec(transportAbi, profile);
  const abiA = hex(encodeWireAbi(abiMetadata('old'), profile));
  const abiB = hex(encodeWireAbi(abiMetadata('new'), profile));
  assert.notEqual(abiA, abiB);
  assert.deepEqual(createWireValueCodec(abiMetadata('old'), profile).decode('sample', Buffer.from('07000000', 'hex')), {old: 7});
  assert.deepEqual(createWireValueCodec(abiMetadata('new'), profile).decode('sample', Buffer.from('07000000', 'hex')), {new: 7});
  const unsupportedAbi = abiA.replace(Buffer.from('sysio::abi/1.3').toString('hex'),
    Buffer.from('sysio::abi/9.9').toString('hex'));
  assert.notEqual(unsupportedAbi, abiA);
  const nameBytes = account => hex(transport.encode('name', account));
  const nativeBytes = (account, abiHex, tail = '') => nameBytes(account)
    + varuint(abiHex.length / 2) + abiHex + tail;
  const setabi = (ordinal, sequence, account, abiHex, extra = {}) => spec(ordinal, sequence, {
    receiver: 'sysio', account: 'sysio', name: 'setabi', rawHex: nativeBytes(account, abiHex),
    authorization: [{actor: account, permission: 'active'}], ...extra,
  });
  const row = (account, abiHex, ordinal = 0, present = true, timestamp = accountTimestamp) => {
    const value = ['account_v0', {name: account, creation_date: timestamp, abi: abiHex}];
    return {ordinal, present, rawHex: hex(transport.encode('account', value)), value};
  };
  const state = (account, abiHex, deltaOrdinal = 0, present = true) => ({account, present, abiHex, deltaOrdinal});
  const add = (id, input, expected, sourceChange = {}) => vectors.push({
    id: profile.id + ':' + id, profileId: profile.id, source: {...source, ...sourceChange}, input, expected,
  });
  const baseInput = () => ({traces: [transaction([spec(1, 100)])], accountRows: []});
  const bad = (id, mutate, expectedError = 'invalid_value') => {
    const input = baseInput(), block = copy(source);
    mutate(input, block);
    vectors.push({id: profile.id + ':' + id, profileId: profile.id, source: block, input, expectedError});
  };
  const tx = input => input.traces[0][1];
  const act = input => tx(input).action_traces[0][1];
  const receipt = input => act(input).receipt[1];

  add('empty-known-predecessor', {traces: [], accountRows: []}, emptyFacts());
  add('empty-null-predecessor', {traces: [], accountRows: []}, emptyFacts(), {previousBlockId: null});
  add('snapshot-final-state-only', {traces: [], accountRows: [row('target', abiA)]},
    {...emptyFacts(), finalStates: [state('target', abiA)]}, {previousBlockId: null});
  const plain = spec(1, '18446744073709551615', {receiptAbiSequence: '4294967295'});
  add('maximum-lossless-receipt-sequences', {traces: [transaction([plain])], accountRows: []},
    {...emptyFacts(), actionInputs: [fact(plain)]});

  const oldDeploy = setabi(1, '9007199254740993', 'target', abiA);
  const oldAction = spec(2, '9007199254740994', {receiptAbiSequence: '1'});
  const newDeploy = setabi(3, '9007199254740995', 'target', abiB);
  const newAction = spec(4, '9007199254740996', {receiptAbiSequence: '2'});
  add('same-width-old-new-uint32', {
    traces: [transaction([oldDeploy, oldAction, newDeploy, newAction])], accountRows: [row('target', abiB)],
  }, {schemaVersion: 1, actionInputs: [fact(oldDeploy), fact(oldAction), fact(newDeploy), fact(newAction)],
    deployments: [deployment(oldDeploy, 'target', abiA), deployment(newDeploy, 'target', abiB)],
    finalStates: [state('target', abiB)]});

  const root = spec(1, 200, {name: 'dispatch'});
  const laterRoot = spec(2, 202);
  const inlineDeploy = setabi(3, 201, 'target', abiB, {creator: 1});
  add('allocation-1-2-3-execution-1-3-2', {
    traces: [transaction([root, laterRoot, inlineDeploy])], accountRows: [row('target', abiB)],
  }, {schemaVersion: 1, actionInputs: [fact(root), fact(inlineDeploy), fact(laterRoot)],
    deployments: [deployment(inlineDeploy, 'target', abiB)], finalStates: [state('target', abiB)]});

  const updates = [setabi(1, 300, 'target', abiA), setabi(2, 301, 'target', abiA),
    setabi(3, 302, 'target', ''), setabi(4, 303, 'target', 'ff'),
    setabi(5, 304, 'target', unsupportedAbi), setabi(6, 305, 'target', abiB)];
  add('multiple-identical-clear-malformed-unsupported-valid', {
    traces: [transaction(updates)], accountRows: [row('target', abiB)],
  }, {schemaVersion: 1, actionInputs: updates.map(action => fact(action)),
    deployments: updates.map((action, index) => deployment(action, 'target',
      [abiA, abiA, '', 'ff', unsupportedAbi, abiB][index])), finalStates: [state('target', abiB)]});
  const clear = setabi(1, 350, 'target', '');
  add('cleared-final-state-barrier', {traces: [transaction([clear])], accountRows: [row('target', '')]},
    {schemaVersion: 1, actionInputs: [fact(clear)], deployments: [deployment(clear, 'target', '')],
      finalStates: [state('target', '')]});
  const rejected = setabi(1, 351, 'target', 'ff');
  add('malformed-final-state-barrier', {traces: [transaction([rejected])], accountRows: [row('target', 'ff')]},
    {schemaVersion: 1, actionInputs: [fact(rejected)], deployments: [deployment(rejected, 'target', 'ff')],
      finalStates: [state('target', 'ff')]});

  const self = setabi(1, 500, 'sysio', abiB, {receiptAbiSequence: '9'});
  const notify = {...self, ordinal: 2, globalSequence: '501', receiver: 'alice', creator: 1};
  const notifyChain = {...self, ordinal: 3, globalSequence: '502', receiver: 'bob', creator: 2};
  add('self-setabi-notification-chain', {
    traces: [transaction([self, notify, notifyChain])], accountRows: [row('sysio', abiB)],
  }, {schemaVersion: 1, actionInputs: [fact(self), fact(notify, 1), fact(notifyChain, 1)],
    deployments: [deployment(self, 'sysio', abiB)], finalStates: [state('sysio', abiB)]});
  const repeatedRoot = spec(1, 600);
  const identicalInline = spec(2, 602, {creator: 1});
  const repeatedNotify = spec(3, 601, {creator: 1, receiver: 'alice'});
  add('identical-inline-owns-input', {
    traces: [transaction([repeatedRoot, identicalInline, repeatedNotify])], accountRows: [],
  }, {...emptyFacts(), actionInputs: [fact(repeatedRoot), fact(repeatedNotify, 1), fact(identicalInline, 2)]});
  const onblock = spec(1, 700, {receiver: 'sysio', account: 'sysio', name: 'onblock', rawHex: '',
    authorization: [{actor: 'sysio', permission: 'active'}]});
  add('onblock-source-retained', {traces: [transaction([onblock], otherTransactionId)], accountRows: []},
    {...emptyFacts(), actionInputs: [fact(onblock, 1, otherTransactionId)]});
  const unnamed = spec(1, 701, {receiver: 'sysio', account: 'sysio', name: '', rawHex: ''});
  add('empty-action-name', {traces: [transaction([unnamed])], accountRows: []},
    {...emptyFacts(), actionInputs: [fact(unnamed)]});
  const contextFree = spec(1, 702, {contextFree: true, authorization: []});
  add('ordinary-context-free-action', {traces: [transaction([contextFree])], accountRows: []},
    {...emptyFacts(), actionInputs: [fact(contextFree)]});
  const numericFalse = spec(1, 703, {contextFree: 0});
  const numericFalseTransaction = transaction([numericFalse]);
  numericFalseTransaction[1].scheduled = 0;
  add('ship-numeric-false-flags', {traces: [numericFalseTransaction], accountRows: []},
    {...emptyFacts(), actionInputs: [fact(numericFalse)]});
  const numericTrue = spec(1, 704, {contextFree: 1, authorization: []});
  const numericTrueTransaction = transaction([numericTrue]);
  numericTrueTransaction[1].scheduled = 0;
  add('ship-numeric-context-free-one', {traces: [numericTrueTransaction], accountRows: []},
    {...emptyFacts(), actionInputs: [fact(numericTrue)]});
  const mixedRoot = spec(1, 705), mixedNotify = spec(2, 706, {creator: 1, receiver: 'alice', contextFree: 0});
  add('mixed-boolean-numeric-notification-flags', {
    traces: [transaction([mixedRoot, mixedNotify])], accountRows: [],
  }, {...emptyFacts(), actionInputs: [fact(mixedRoot), fact(mixedNotify, 1)]});
  add('removed-account-row-retains-presence', {traces: [], accountRows: [row('target', abiA, 0, false)]},
    {...emptyFacts(), finalStates: [state('target', abiA, 0, false)]});
  add('final-state-row-order', {traces: [], accountRows: [row('target', abiA, 9), row('other', abiB, 1)]},
    {...emptyFacts(), finalStates: [state('other', abiB, 1), state('target', abiA, 9)]});
  for (const [id, suffix, abiHex] of [
    ['native-trailing-bytes', '01ffaabb', 'ff'],
    ['native-overlong-zero-length', '8000aabb', ''],
    ['native-fifth-byte-high-continuation-zero', '8080808090aabb', ''],
    ['native-fifth-byte-high-continuation-one', '8180808090ffaabb', 'ff'],
  ]) {
    const native = setabi(1, 800, 'target', abiHex, {rawHex: nameBytes('target') + suffix});
    add(id, {traces: [transaction([native])], accountRows: []},
      {...emptyFacts(), actionInputs: [fact(native)], deployments: [deployment(native, 'target', abiHex)]});
  }
  // Reverse input order forces full ancestry traversal before any origin cache has been populated.
  const ancestry = count => Array.from({length: count + 1}, (_, index) => spec(index + 1, 1000 + index,
    index === 0 ? {} : {receiver: 'note' + String.fromCharCode(97 + Math.floor((index - 1) / 26))
      + String.fromCharCode(97 + (index - 1) % 26), creator: index}));
  const maximumDepth = ancestry(64);
  add('notification-ancestry-depth-64', {traces: [transaction([...maximumDepth].reverse())], accountRows: []},
    {...emptyFacts(), actionInputs: maximumDepth.map(action => fact(action, 1))});
  bad('notification-ancestry-depth-65', input => {input.traces = [transaction(ancestry(65).reverse())];}, 'limits_exceeded');
  bad('trace-collection-over-limit', input => {input.traces = Array(100001).fill(null);}, 'limits_exceeded');

  bad('missing-traces', input => {delete input.traces;});
  bad('missing-account-rows', input => {delete input.accountRows;});
  bad('null-traces', input => {input.traces = null;});
  bad('null-account-rows', input => {input.accountRows = null;});
  bad('wrong-transaction-variant', input => {input.traces[0][0] = 'transaction_trace_v2';}, 'unsupported_feature');
  bad('malformed-transaction-variant', input => {input.traces[0] = ['transaction_trace_v0'];});
  bad('null-transaction-payload', input => {input.traces[0][1] = null;});
  bad('wrong-action-variant', input => {tx(input).action_traces[0][0] = 'action_trace_v2';}, 'unsupported_feature');
  bad('malformed-action-variant', input => {tx(input).action_traces[0] = {};});
  bad('wrong-receipt-variant', input => {act(input).receipt[0] = 'action_receipt_v1';}, 'unsupported_feature');
  bad('malformed-receipt-variant', input => {act(input).receipt = ['action_receipt_v0'];});
  for (const status of [1, 2, 3, 4]) bad('transaction-status-' + status,
    input => {tx(input).status = status;}, 'unsupported_feature');
  bad('scheduled-transaction', input => {tx(input).scheduled = true;}, 'unsupported_feature');
  bad('ship-numeric-scheduled-one', input => {tx(input).scheduled = 1;}, 'unsupported_feature');
  bad('nested-failed-transaction', input => {tx(input).failed_dtrx_trace = transaction([]);}, 'unsupported_feature');
  bad('transaction-exception', input => {tx(input).except = 'rolled back';});
  bad('transaction-error-code', input => {tx(input).error_code = '1';});
  bad('action-exception', input => {act(input).except = 'rolled back';});
  bad('action-error-code', input => {act(input).error_code = '1';});
  bad('missing-action-traces', input => {delete tx(input).action_traces;});
  bad('missing-receipt', input => {delete act(input).receipt;});
  bad('null-receipt', input => {act(input).receipt = null;});
  bad('receipt-receiver-mismatch', input => {receipt(input).receiver = 'other';});
  for (const [id, value] of [['zero', '0'], ['negative', '-1'], ['number', 100],
    ['unsafe-number', 9007199254740992], ['overflow', '18446744073709551616'],
    ['noncanonical', '0100'], ['exponent', '1e2']]) {
    bad('global-sequence-' + id, input => {receipt(input).global_sequence = value;});
  }
  bad('duplicate-global-sequence', input => {tx(input).action_traces.push(actionTrace(spec(2, 100)));});
  bad('abi-sequence-overflow', input => {receipt(input).abi_sequence = 4294967296;});
  bad('abi-sequence-negative', input => {receipt(input).abi_sequence = -1;});
  bad('duplicate-transaction', input => {input.traces.push(copy(input.traces[0]));});
  bad('duplicate-action-ordinal', input => {tx(input).action_traces.push(actionTrace(spec(1, 101)));});
  bad('missing-creator', input => {act(input).creator_action_ordinal = 7;});
  bad('self-cyclic-creator', input => {act(input).creator_action_ordinal = 1;});
  bad('two-action-creator-cycle', input => {input.traces = [transaction([spec(1, 100, {creator: 2}), spec(2, 101, {creator: 1})])];});
  bad('creator-execution-inverted', input => {input.traces = [transaction([spec(1, 100), spec(2, 99, {creator: 1})])];});
  bad('notification-missing-origin', input => {act(input).receiver = 'alice'; receipt(input).receiver = 'alice';});
  bad('notification-authorization-mismatch', input => {input.traces = [transaction([spec(1, 100),
    spec(2, 101, {creator: 1, receiver: 'alice', authorization: [{actor: 'target', permission: 'owner'}]})])];});
  bad('notification-raw-mismatch', input => {input.traces = [transaction([spec(1, 100),
    spec(2, 101, {creator: 1, receiver: 'alice', rawHex: '08000000'})])];});
  bad('notification-name-mismatch', input => {input.traces = [transaction([spec(1, 100),
    spec(2, 101, {creator: 1, receiver: 'alice', name: 'other'})])];});
  bad('missing-authorization', input => {delete act(input).act.authorization;});
  bad('missing-context-free-flag', input => {delete act(input).context_free;});
  bad('invalid-context-free-two', input => {act(input).context_free = 2;});
  bad('odd-action-hex', input => {act(input).act.data = '0';});
  bad('missing-action-bytes', input => {delete act(input).act.data;});
  for (const [id, bytes] of [['empty', ''], ['account-only', nameBytes('target')],
    ['truncated-abi', nameBytes('target') + '02ff'], ['truncated-length', nameBytes('target') + '80'],
    ['truncated-fifth-length-byte', nameBytes('target') + '80808080']]) {
    bad('native-prefix-' + id, input => {input.traces = [transaction([setabi(1, 100, 'target', '', {rawHex: bytes})])];});
  }
  bad('context-free-native-setabi', input => {input.traces = [transaction([
    setabi(1, 100, 'target', '', {contextFree: true, authorization: []})])];}, 'unsupported_feature');
  bad('ship-numeric-context-free-native-setabi', input => {input.traces = [transaction([
    setabi(1, 100, 'target', '', {contextFree: 1, authorization: []})])];}, 'unsupported_feature');
  bad('row-abi-mismatch', input => {const entry = row('target', abiA); entry.value[1].abi = abiB; input.accountRows = [entry];});
  bad('row-creation-date-mismatch', input => {const entry = row('target', abiA);
    entry.value[1].creation_date = '2025-01-01T00:00:00.500'; input.accountRows = [entry];});
  bad('row-account-mismatch', input => {const entry = row('target', abiA); entry.value[1].name = 'other'; input.accountRows = [entry];});
  bad('row-truncated-raw', input => {const entry = row('target', abiA); entry.rawHex = entry.rawHex.slice(0, -2); input.accountRows = [entry];});
  bad('duplicate-row-ordinal', input => {input.accountRows = [row('target', abiA), row('other', abiB)];});
  bad('duplicate-row-account', input => {input.accountRows = [row('target', abiA), row('target', abiB, 1)];});
  bad('missing-row-presence', input => {const entry = row('target', abiA); delete entry.present; input.accountRows = [entry];});
  bad('row-presence-remains-sdk-boolean', input => {input.accountRows = [row('target', abiA, 0, 1)];});
  for (const [id, value] of [['negative', -1], ['fractional', 0.5], ['overflow', 4294967296]]) {
    bad('row-ordinal-' + id, input => {input.accountRows = [row('target', abiA, value)];});
  }
  for (const field of ['chainId', 'blockId', 'previousBlockId']) {
    bad('source-' + field + '-invalid', (_input, block) => {block[field] = 'not-a-digest';});
  }
  bad('missing-predecessor-field', (_input, block) => {delete block.previousBlockId;});
  for (const [id, value] of [['zero', 0], ['negative', -1], ['fractional', 1.5],
    ['overflow', 4294967296], ['unsafe', 9007199254740992]]) {
    bad('source-block-number-' + id, (_input, block) => {block.blockNum = value;});
  }
  bad('invalid-transaction-id', input => {tx(input).id = 'not-a-digest';});
  for (const [id, value] of [['zero', 0], ['negative', -1], ['fractional', 1.5], ['overflow', 4294967296]]) {
    bad('action-ordinal-' + id, input => {act(input).action_ordinal = value;});
  }
}
const output = {schemaVersion: 1,
  description: 'Synthetic ABI observation conformance inputs. Expected source facts are manually specified; no observer output is used. No canonical coverage, ABI applicability, live-chain acceptance or launch qualification is implied.',
  sourcePins: codecProfiles.map(profile => ({profileId: profile.id, upstreamRevision: profile.upstreamRevision})),
  vectors};
// Keep the explicit resource-guard arrays on one line instead of adding 200002 noise lines.
const guardArray = Array(100001).fill(null);
const prettyGuardArray = JSON.stringify(guardArray, null, 2).replaceAll('\n', '\n        ');
const serialized = JSON.stringify(output, null, 2).replaceAll(prettyGuardArray, JSON.stringify(guardArray));
const fixtureFile = new URL('./vectors.json', import.meta.url);
const expectedBytes = Buffer.from(serialized + '\n');
if (process.argv.length === 3 && process.argv[2] === '--check') {
  const actualBytes = await readFile(fixtureFile);
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error('ABI observation fixtures differ from the manual generator or required LF bytes; review before regenerating.');
  }
  console.log('Verified ' + vectors.length + ' manually-oracled ABI observation vectors, including exact LF bytes.');
} else {
  if (process.argv.length !== 2) throw new Error('Usage: node fixtures/abi-observations/generate.mjs [--check]');
  await writeFile(fixtureFile, expectedBytes);
  console.log('Wrote ' + vectors.length + ' manually-oracled ABI observation vectors.');
}
