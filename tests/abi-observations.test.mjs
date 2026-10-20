import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createProtocolProvider} from '../dist/provider.js';
import {createWireShipCodec, createWireValueCodec, codecProfiles, resolveCodecProfile, WireCodecError} from '../dist/index.js';
import {fromHex} from '../dist/codec/binary.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/abi-observations/vectors.json', import.meta.url), 'utf8'));
const handshake = JSON.parse(readFileSync(new URL('../fixtures/codec/ship.abi.json', import.meta.url), 'utf8'));
const raw = hex => new Uint8Array(Buffer.from(hex, 'hex'));
const inputFor = input => ({traces: input?.traces, accountRows: Array.isArray(input?.accountRows)
  ? input.accountRows.map(row => row && typeof row === 'object' && !Array.isArray(row)
    ? {ordinal: row.ordinal, present: row.present, raw: fromHex(row.rawHex), value: row.value} : row)
  : input?.accountRows});

test('captured 7dede884 block retains onblock and final system ABI through the selected SHiP session', () => {
  const capture = JSON.parse(readFileSync(new URL('../fixtures/codec/ship-capture.json', import.meta.url), 'utf8'));
  const vectors = JSON.parse(readFileSync(new URL('../fixtures/codec/ship-vectors.json', import.meta.url), 'utf8'));
  const vector = vectors.vectors.find(vector => vector.id === 'captured-ship-block-result');
  const profile = resolveCodecProfile(vector.profileId);
  const bundle = createWireShipCodec(handshake, profile).decodeBundle(raw(vector.hex));
  const result = bundle.envelope[1];
  const rows = bundle.deltaRows.flatMap((row, ordinal) => row.stream === 'account'
    ? [{ordinal, present: row.present === 1, raw: raw(row.rawHex), value: row.value}] : []);
  const source = {chainId: capture.chainInfo.chain_id, blockId: result.this_block.block_id,
    blockNum: result.this_block.block_num, previousBlockId: result.prev_block.block_id};
  const facts = createProtocolProvider(profile.id).observeBlockAbi({traces: bundle.traces, accountRows: rows}, source);
  assert.equal(source.blockNum, 6350);
  assert.equal(facts.actionInputs.length, 1);
  assert.equal(facts.actionInputs[0].name, 'onblock');
  assert.equal(facts.actionInputs[0].account, 'sysio');
  assert.equal(facts.actionInputs[0].globalSequence, '6349');
  assert.equal(facts.actionInputs[0].inputActionOrdinal, 1);
  assert.deepEqual(facts.deployments, []);
  assert.equal(facts.finalStates.length, 1);
  assert.equal(facts.finalStates[0].account, 'sysio');
  assert.equal(facts.finalStates[0].abiHex, rows[0].value[1].abi);
});

for (const vector of fixture.vectors) {
  test(`${vector.profileId}: ABI source facts ${vector.id}`, () => {
    const provider = createProtocolProvider(vector.profileId);
    const source = structuredClone(vector.source);
    if (Object.hasOwn(vector, 'expectedError')) {
      assert.throws(() => provider.observeBlockAbi(inputFor(structuredClone(vector.input)), source), error =>
        error instanceof WireCodecError && error.code === vector.expectedError);
    } else {
      const input = inputFor(structuredClone(vector.input));
      const before = structuredClone({input, source});
      const observed = provider.observeBlockAbi(input, source);
      assert.deepEqual(observed, vector.expected);
      assert.deepEqual({input, source}, before, 'Capturing facts must not mutate the source');
      // Exercise the selected production SHiP session, not only hand-built decoded inputs.
      const profile = codecProfiles.find(profile => profile.id === vector.profileId);
      const codec = createWireValueCodec(handshake, profile);
      const session = provider.createShipSession(handshake);
      const decoded = {traces: session.decodeTraces(codec.encode('transaction_trace[]', input.traces)),
        accountRows: input.accountRows.map(row => ({...row, value: session.decodeRow('account', row.raw)}))};
      assert.deepEqual(provider.observeBlockAbi(decoded, source), vector.expected);
      if (input.traces.length) input.traces[0][1].action_traces.length = 0;
      if (input.accountRows.length) input.accountRows[0].raw.fill(255);
      assert.deepEqual(observed, vector.expected, 'Returned facts must be detached from mutable source objects');
    }
  });
}

for (const profile of codecProfiles) {
  test(`${profile.id}: ABI source facts reject bounded collection overflow and sparse rows`, () => {
    const provider = createProtocolProvider(profile.id);
    const source = {chainId: 'a'.repeat(64), blockId: 'b'.repeat(64), previousBlockId: null, blockNum: 1};
    for (const input of [{traces: Array(100_001).fill(null), accountRows: []},
      {traces: [], accountRows: Array(100_001).fill(null)}]) {
      assert.throws(() => provider.observeBlockAbi(input, source), error =>
        error instanceof WireCodecError && error.code === 'limits_exceeded');
    }
    assert.throws(() => provider.observeBlockAbi({traces: [], accountRows: Array(1)}, source), WireCodecError);
    assert.throws(() => provider.observeBlockAbi({traces: [], accountRows: [null]}, source), WireCodecError);
    assert.throws(() => provider.observeBlockAbi({traces: [], accountRows: []}, null), WireCodecError);
  });
}
