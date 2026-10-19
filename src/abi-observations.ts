import type {ProtocolBlockAbiInput, ProtocolBlockAbiObservations, ProtocolBlockAbiSource,
  ProtocolAbiActionInput, ProtocolAbiDeploymentObservation} from '@eosrio/hyperion-sdk/protocol';
import {BinaryReader, CODEC_LIMITS, fromHex, integer, plainObject, toHex} from './codec/binary.js';
import {codecAssert} from './codec/errors.js';
import {createWireValueCodec} from './codec/values.js';
import type {WireCodecProfile} from './profiles.js';
import {Buffer} from 'node:buffer';

// Physical state-history account layout at both pinned nodes. ABI bytes remain opaque.
const accountAbi = {version: 'sysio::abi/1.3', structs: [
  {name: 'account_v0', base: '', fields: [
    {name: 'name', type: 'name'}, {name: 'creation_date', type: 'block_timestamp_type'},
    {name: 'abi', type: 'bytes'}]},
], variants: [{name: 'account', types: ['account_v0']}]};

function variant(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  codecAssert(Array.isArray(value) && value.length === 2 && typeof value[0] === 'string', 'Malformed ABI observation variant');
  codecAssert(allowed.includes(value[0]),
    `Unsupported ABI observation variant (expected ${allowed.join(' or ')})`, 'unsupported_feature');
  return plainObject(value[1]);
}

function ordinal(value: unknown, positive = false): number {
  codecAssert(typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0)
    && value <= 0xffff_ffff, 'Invalid source ordinal');
  return value;
}

function digest(value: unknown): void {
  codecAssert(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'Invalid source digest');
}

function sequence(value: unknown, bits: number, positive = false): string {
  // SHiP uint64 values must survive host parsing without Number's precision loss.
  codecAssert(bits !== 64 || typeof value === 'string', 'Expected lossless decimal uint64');
  const number = integer(value, bits);
  codecAssert(!positive || number > 0n, 'A committed receipt requires a positive global sequence');
  return number.toString();
}

function sourceFlag(value: unknown): boolean {
  // The pinned ABI codec preserves fc's uint8 bool carrier in decoded SHiP values.
  codecAssert(typeof value === 'boolean' || value === 0 || value === 1, 'Invalid source context-free flag');
  return value === true || value === 1;
}

/**
 * Native fc::raw::unpack does not enforce the generic codec's canonical varuint/end rules.
 * Its unsigned_int length consumes at most five bytes and retains the low 32 bits.
 * Preserve the complete input elsewhere; only the native account/vector prefix changes state.
 */
function nativeAbi(bytes: Uint8Array, name: (bytes: Uint8Array) => string) {
  const reader = new BinaryReader(bytes);
  const account = name(reader.take(8));
  let size = 0;
  for (let index = 0; index < 5; index++) {
    const byte = reader.u8();
    size = (size | ((byte & 127) << (7 * index))) >>> 0;
    if (!(byte & 128)) break;
  }
  return {account, abiHex: toHex(reader.take(size))};
}

interface Occurrence {
  fact: Omit<ProtocolAbiActionInput, 'inputActionOrdinal'>;
  creator: number;
  contextFree: boolean;
  actionIdentity: string;
}

/** Match the Rust JSON boundary, counting typed raw bytes as their wire JSON hex representation. */
function observationBudget(value: unknown): void {
  const stack: [unknown, number][] = [[value, 0]];
  let nodes = 0, textBytes = 0;
  while (stack.length) {
    const [current, depth] = stack.pop()!;
    codecAssert(++nodes <= CODEC_LIMITS.maxNodes && depth <= CODEC_LIMITS.maxDepth,
      'ABI observation traversal exceeds limit', 'limits_exceeded');
    if (typeof current === 'string') textBytes += Buffer.byteLength(current);
    else if (current instanceof Uint8Array) textBytes += current.byteLength * 2;
    else if (Array.isArray(current)) {
      codecAssert(current.length <= CODEC_LIMITS.maxItems, 'ABI observation array exceeds limit', 'limits_exceeded');
      for (const item of current) stack.push([item, depth + 1]);
    } else if (current !== null && typeof current === 'object') {
      for (const [key, entry] of Object.entries(plainObject(current))) {
        if (entry === undefined) continue;
        textBytes += Buffer.byteLength(key === 'raw' && entry instanceof Uint8Array ? 'rawHex' : key);
        stack.push([entry, depth + 1]);
      }
    } else {
      codecAssert(current === null || current === undefined || typeof current === 'boolean'
        || (typeof current === 'number' && Number.isFinite(current)), 'Invalid observation JSON value');
    }
    codecAssert(textBytes <= CODEC_LIMITS.maxBytes, 'ABI observation text exceeds limit', 'limits_exceeded');
  }
}

/** Source facts only. This function neither chooses an ABI nor proves canonical coverage. */
export function observeWireBlockAbi(input: ProtocolBlockAbiInput, source: ProtocolBlockAbiSource,
                                   profile: WireCodecProfile): ProtocolBlockAbiObservations {
  plainObject(input); plainObject(source);
  observationBudget(input); observationBudget(source);
  digest(source.chainId); digest(source.blockId);
  if (source.previousBlockId !== null) digest(source.previousBlockId);
  ordinal(source.blockNum, true);
  codecAssert(Array.isArray(input.traces) && Array.isArray(input.accountRows), 'Missing required ABI observation input');
  codecAssert(input.traces.length <= CODEC_LIMITS.maxItems && input.accountRows.length <= CODEC_LIMITS.maxItems,
    'ABI observation collection exceeds limit', 'limits_exceeded');
  const physical = createWireValueCodec(accountAbi, profile);
  const name = (value: unknown) => {
    const decoded = physical.decode('name', physical.encode('name', value));
    codecAssert(typeof decoded === 'string' && decoded === value, 'Invalid source name');
    return decoded;
  };
  const actionInputs: ProtocolAbiActionInput[] = [];
  const deployments: ProtocolAbiDeploymentObservation[] = [];
  const seenTransactions = new Set<string>();
  const seenSequences = new Set<string>();
  for (const trace of input.traces) {
    const transaction = variant(trace, ['transaction_trace_v0']);
    digest(transaction.id);
    const transactionId = transaction.id as string;
    codecAssert(!seenTransactions.has(transactionId), 'Duplicate source transaction');
    seenTransactions.add(transactionId);
    // These pins emit only receipt-bearing accepted transactions, including onblock.
    // Other statuses/deferred traces cannot be interpreted as committed native effects.
    codecAssert(transaction.status === 0 && (transaction.scheduled === false || transaction.scheduled === 0)
      && transaction.failed_dtrx_trace === null, 'Unsupported committed Wire transaction semantics', 'unsupported_feature');
    codecAssert(transaction.except === null && transaction.error_code === null, 'Failed transaction is not a committed ABI source');
    codecAssert(Array.isArray(transaction.action_traces), 'Missing source action traces');
    codecAssert(actionInputs.length + transaction.action_traces.length <= CODEC_LIMITS.maxItems,
      'ABI observation actions exceed limit', 'limits_exceeded');
    const occurrences = new Map<number, Occurrence>();
    for (const raw of transaction.action_traces) {
      const trace = variant(raw, ['action_trace_v0', 'action_trace_v1']);
      const actionOrdinal = ordinal(trace.action_ordinal, true);
      codecAssert(!occurrences.has(actionOrdinal), 'Duplicate source action ordinal');
      const creator = ordinal(trace.creator_action_ordinal);
      codecAssert(trace.except === null && trace.error_code === null, 'Failed action is not a committed ABI source');
      const contextFree = sourceFlag(trace.context_free);
      const receipt = variant(trace.receipt, ['action_receipt_v0']);
      const receiver = name(trace.receiver);
      codecAssert(name(receipt.receiver) === receiver, 'Receipt receiver does not match source action');
      const globalSequence = sequence(receipt.global_sequence, 64, true);
      codecAssert(!seenSequences.has(globalSequence), 'Duplicate committed global sequence');
      seenSequences.add(globalSequence);
      const action = plainObject(trace.act);
      const account = name(action.account), actionName = name(action.name);
      const rawHex = toHex(fromHex(action.data));
      codecAssert(Array.isArray(action.authorization), 'Missing source action authorization');
      codecAssert(action.authorization.length <= CODEC_LIMITS.maxItems, 'Authorization exceeds limit', 'limits_exceeded');
      const authorization = action.authorization.map(value => {
        const permission = plainObject(value);
        return [name(permission.actor), name(permission.permission)];
      });
      occurrences.set(actionOrdinal, {
        fact: {transactionId, actionOrdinal, receiver, account, name: actionName, rawHex,
          globalSequence, receiptAbiSequence: sequence(receipt.abi_sequence, 32)},
        creator, contextFree,
        actionIdentity: JSON.stringify([account, actionName, authorization, rawHex, contextFree]),
      });
    }
    // Creator links describe allocation ancestry. Receipts establish execution order.
    // Check every link, including first receivers, before resolving notification input origins.
    for (const entry of occurrences.values()) {
      if (entry.creator === 0) continue;
      const parent = occurrences.get(entry.creator);
      codecAssert(parent && BigInt(parent.fact.globalSequence) < BigInt(entry.fact.globalSequence),
        'Missing, cyclic or unordered creator ancestry');
    }
    const origins = new Map<number, number>();
    const origin = (entry: Occurrence): number => {
      let current = entry;
      const path: number[] = [];
      while (!origins.has(current.fact.actionOrdinal) && current.fact.receiver !== current.fact.account) {
        codecAssert(path.length < CODEC_LIMITS.maxDepth, 'Notification ancestry exceeds limit', 'limits_exceeded');
        path.push(current.fact.actionOrdinal);
        const parent = occurrences.get(current.creator);
        codecAssert(parent && parent.actionIdentity === current.actionIdentity,
          'Notification does not match its originating action input');
        current = parent;
      }
      const result = origins.get(current.fact.actionOrdinal) ?? current.fact.actionOrdinal;
      origins.set(current.fact.actionOrdinal, result);
      for (const ordinal of path) origins.set(ordinal, result);
      return result;
    };
    for (const entry of occurrences.values()) {
      const inputActionOrdinal = origin(entry);
      const fact = {...entry.fact, inputActionOrdinal};
      actionInputs.push(fact);
      if (fact.receiver === 'sysio' && fact.account === 'sysio' && fact.name === 'setabi') {
        codecAssert(!entry.contextFree, 'Context-free native ABI mutation is unsupported', 'unsupported_feature');
        const update = nativeAbi(fromHex(fact.rawHex), bytes => name(physical.decode('name', bytes)));
        deployments.push({...update, action: {transactionId, actionOrdinal: fact.actionOrdinal},
          globalSequence: fact.globalSequence, effect: 'native-before-receipt'});
      }
    }
  }
  const seenRows = new Set<number>();
  const seenAccounts = new Set<string>();
  const finalStates = Array.from(input.accountRows, row => {
    plainObject(row);
    const deltaOrdinal = ordinal(row.ordinal);
    codecAssert(!seenRows.has(deltaOrdinal), 'Duplicate source account row ordinal');
    seenRows.add(deltaOrdinal);
    codecAssert(typeof row.present === 'boolean' && row.raw instanceof Uint8Array, 'Invalid source account row');
    const decoded = variant(physical.decode('account', row.raw), ['account_v0']);
    codecAssert(toHex(physical.encode('account', row.value)) === toHex(row.raw), 'Account row does not match its raw bytes');
    const account = name(decoded.name);
    codecAssert(!seenAccounts.has(account), 'Duplicate final account state');
    seenAccounts.add(account);
    return {account, present: row.present, abiHex: toHex(fromHex(decoded.abi)), deltaOrdinal};
  });
  const order = (left: {globalSequence: string}, right: {globalSequence: string}) =>
    BigInt(left.globalSequence) < BigInt(right.globalSequence) ? -1 : 1;
  actionInputs.sort(order); deployments.sort(order);
  finalStates.sort((left, right) => left.deltaOrdinal - right.deltaOrdinal);
  return {schemaVersion: 1, actionInputs, deployments, finalStates};
}
