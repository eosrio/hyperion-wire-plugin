import type {ProtocolBlockAbiSource, ProtocolNativeActionBlockInput, ProtocolNativeActionDecision,
  ProtocolNativeActions} from '@eosrio/hyperion-sdk/protocol';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {observeWireBlockAbi} from './abi-observations.js';
import {CODEC_LIMITS, fromHex, plainObject, toHex} from './codec/binary.js';
import {codecAssert, WireCodecError} from './codec/errors.js';
import {createWireValueCodec} from './codec/values.js';
import {nativeActionAbi} from './native-action-abi.js';
import {nativeActionProfileId, resolveCodecProfile, type WireCodecProfile} from './profiles.js';

const schemaSha256 = '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9';
const nativeKind = 'wire.sysio.onblock.v1';
const headerFields = ['timestamp', 'producer', 'previous', 'transaction_mroot', 'finality_mroot', 'qc_claim',
  'new_finalizer_policy_diff', 'new_proposer_policy_diff', 'header_extensions'];
const packedLimit = 10 * 1024 * 1024; // Pinned transaction.cpp's maximum decompressed transaction size.
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Codec = ReturnType<typeof createWireValueCodec>;

function digest(value: unknown): asserts value is string {
  codecAssert(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'Invalid native source digest');
}
function bytes(value: unknown): Uint8Array {
  codecAssert(value instanceof Uint8Array && value.byteLength > 0, 'Missing native source section');
  codecAssert(value.byteLength <= CODEC_LIMITS.maxBytes, 'Native source section exceeds limit', 'limits_exceeded');
  return Uint8Array.prototype.slice.call(value) as Uint8Array;
}
function variant(value: unknown, tag: string): Record<string, unknown> {
  codecAssert(Array.isArray(value) && value.length === 2 && value[0] === tag,
    'Unsupported native source variant', 'unsupported_feature');
  return plainObject(value[1]);
}
function actionVariant(value: unknown): Record<string, unknown> {
  codecAssert(Array.isArray(value) && value.length === 2
    && (value[0] === 'action_trace_v0' || value[0] === 'action_trace_v1'),
    'Unsupported native action trace variant', 'unsupported_feature');
  return plainObject(value[1]);
}
function headerId(codec: Codec, value: Record<string, unknown>, expected: number): string {
  digest(value.previous);
  codecAssert(Number.parseInt(value.previous.slice(0, 8), 16) + 1 === expected, 'Native header height mismatch');
  const header = Object.fromEntries(headerFields.map(name => [name, value[name]]));
  const result = createHash('sha256').update(codec.encode('block_header', header)).digest();
  result.writeUInt32BE(expected, 0);
  return result.toString('hex');
}
function packedIds(codec: Codec, block: Record<string, unknown>): Set<string> {
  codecAssert(Array.isArray(block.transactions), 'Missing packed block transactions');
  codecAssert(block.transactions.length <= CODEC_LIMITS.maxItems, 'Packed membership exceeds limit', 'limits_exceeded');
  const ids = new Set<string>(); let total = 0;
  for (const raw of block.transactions) {
    const receipt = plainObject(raw), packed = plainObject(receipt.trx);
    codecAssert(packed.compression === 0 || packed.compression === 1, 'Unsupported packed compression', 'unsupported_feature');
    let transaction = fromHex(packed.packed_trx);
    if (packed.compression === 1) {
      let result: {buffer: Buffer; engine: {bytesWritten: number}};
      try {
        result = inflateSync(transaction, {maxOutputLength: packedLimit, info: true}) as unknown as typeof result;
      } catch (error) {
        throw new WireCodecError((error as {code?: string}).code === 'ERR_BUFFER_TOO_LARGE' ? 'limits_exceeded' : 'invalid_value',
          'Invalid or oversized compressed packed transaction');
      }
      codecAssert(result.engine.bytesWritten === transaction.length, 'Trailing compressed transaction bytes');
      transaction = result.buffer;
    }
    total += transaction.byteLength;
    codecAssert(transaction.byteLength <= packedLimit && total <= CODEC_LIMITS.maxBytes,
      'Packed membership exceeds byte limit', 'limits_exceeded');
    const decoded = codec.decode('transaction', transaction);
    codecAssert(toHex(codec.encode('transaction', decoded)) === toHex(transaction), 'Noncanonical packed transaction');
    const id = hash(transaction);
    codecAssert(!ids.has(id), 'Duplicate packed transaction membership'); ids.add(id);
  }
  return ids;
}
function incomplete(origin: ProtocolNativeActionDecision['origin'], error: WireCodecError): ProtocolNativeActionDecision {
  const detail = error.code === 'limits_exceeded'
    ? {code: 'native_source_limits', message: 'Native onblock source exceeds verification limits'}
    : error.code === 'unsupported_feature'
      ? {code: 'native_source_unsupported', message: 'Unsupported native onblock source semantics'}
      : {code: 'native_source_invalid', message: 'Native onblock source verification failed'};
  return {origin, kind: 'incomplete', error: detail};
}

/** Source facts and strict values only. The host must independently grant canonical occurrence authority. */
export function createWireNativeActions(profile: WireCodecProfile): ProtocolNativeActions {
  const canonical = resolveCodecProfile(profile.id === nativeActionProfileId
    ? profile.id : 'wire-sysio-6508c9e8-engineering-v1');
  for (const key of Object.keys(canonical) as (keyof WireCodecProfile)[]) {
    codecAssert(profile[key] === canonical[key], 'Native actions require the pinned 6508 profile', 'unsupported_feature');
  }
  const native = createWireValueCodec(nativeActionAbi, canonical);
  const checkKind = (kind: string) => codecAssert(kind === nativeKind, 'Unsupported native action kind', 'unsupported_feature');
  return {
    interfaceVersion: 1,
    decodeValue(kind, raw) {checkKind(kind); return native.decode('wire_native_onblock_v1', raw);},
    encodeValue(kind, value) {checkKind(kind); return native.encode('wire_native_onblock_v1', value);},
    observe(input: ProtocolNativeActionBlockInput, position: ProtocolBlockAbiSource) {
      const record = plainObject(input), supplied = plainObject(position);
      codecAssert(Object.keys(record).sort().join(',') === 'block,schemaJson,traces', 'Invalid native source fields');
      codecAssert(Object.keys(supplied).sort().join(',') === 'blockId,blockNum,chainId,previousBlockId', 'Invalid native position fields');
      digest(supplied.chainId); digest(supplied.blockId); digest(supplied.previousBlockId);
      codecAssert(typeof supplied.blockNum === 'number' && Number.isSafeInteger(supplied.blockNum)
        && supplied.blockNum >= 2 && supplied.blockNum <= 0xffffffff, 'Invalid native source height');
      codecAssert(typeof record.schemaJson === 'string', 'Missing native source schema');
      codecAssert(Buffer.byteLength(record.schemaJson) <= 65536, 'Oversized native source schema', 'limits_exceeded');
      codecAssert(hash(record.schemaJson) === schemaSha256, 'Native source schema does not match pinned source', 'invalid_abi');
      const blockBytes = bytes(record.block), traceBytes = bytes(record.traces);
      const source = {chainId: supplied.chainId, blockNum: supplied.blockNum, blockId: supplied.blockId,
        previousBlockId: supplied.previousBlockId};
      const codec = createWireValueCodec(JSON.parse(record.schemaJson), canonical);
      const block = plainObject(codec.decode('signed_block', blockBytes));
      codecAssert(block.previous === source.previousBlockId && headerId(codec, block, source.blockNum) === source.blockId,
        'Native source block identity mismatch');
      const traces = codec.decode('transaction_trace[]', traceBytes);
      const facts = observeWireBlockAbi({traces, accountRows: []}, source, canonical);
      const decisions: ProtocolNativeActionDecision[] = facts.actionInputs
        .filter(action => action.inputActionOrdinal === action.actionOrdinal && action.receiver === action.account)
        .map(action => ({origin: {transactionId: action.transactionId, actionOrdinal: action.actionOrdinal,
          rawSha256: hash(fromHex(action.rawHex))}, kind: 'contract'}));
      codecAssert(Array.isArray(traces) && traces.length > 0, 'Missing native implicit trace');
      const transaction = variant(traces[0], 'transaction_trace_v0');
      codecAssert(Array.isArray(transaction.action_traces) && transaction.action_traces.length > 0, 'Missing native implicit action');
      const action = actionVariant(transaction.action_traces[0]);
      const index = decisions.findIndex(row => row.origin.transactionId === transaction.id && row.origin.actionOrdinal === action.action_ordinal);
      codecAssert(index >= 0, 'Native source first occurrence is not a verified first receiver');
      const origin = decisions[index]!.origin;
      try {
        const act = plainObject(action.act);
        codecAssert(action.action_ordinal === 1 && action.creator_action_ordinal === 0 && action.receiver === 'sysio'
          && (action.context_free === 0 || action.context_free === false) && act.account === 'sysio' && act.name === 'onblock',
          'Unexpected native implicit root');
        codecAssert(Array.isArray(act.authorization) && act.authorization.length === 1, 'Invalid implicit authorization');
        const authorization = plainObject(act.authorization[0]);
        codecAssert(authorization.actor === 'sysio' && authorization.permission === 'active', 'Invalid implicit authorization');
        const roots = transaction.action_traces.filter(raw => actionVariant(raw).creator_action_ordinal === 0);
        codecAssert(roots.length === 1, 'Implicit transaction must have exactly one root action');
        codecAssert(transaction.partial !== null, 'Missing implicit transaction header');
        const partial = variant(transaction.partial, 'partial_transaction_v0');
        const expected = {expiration: '1970-01-01T00:00:00', ref_block_num: 0, ref_block_prefix: 0,
          max_net_usage_words: 0, max_cpu_usage_ms: 0, delay_sec: 0, transaction_extensions: [], signatures: [], context_free_data: []};
        codecAssert(Object.keys(partial).length === Object.keys(expected).length
          && Object.entries(expected).every(([name, value]) => JSON.stringify(partial[name]) === JSON.stringify(value)), 'Invalid implicit transaction header');
        const raw = fromHex(act.data), decoded = plainObject(native.decode('wire_native_onblock_v1', raw));
        codecAssert(toHex(native.encode('wire_native_onblock_v1', decoded)) === toHex(raw), 'Noncanonical native header');
        codecAssert(headerId(codec, plainObject(decoded.header), source.blockNum - 1) === source.previousBlockId,
          'Native payload is not the selected predecessor header');
        const {signatures: _signatures, context_free_data: _contextFreeData, ...unsignedHeader} = expected;
        const unsigned = {...unsignedHeader, context_free_actions: [], actions: [act]};
        const id = hash(codec.encode('transaction', unsigned));
        codecAssert(id === transaction.id, 'Implicit transaction identity mismatch');
        codecAssert(!packedIds(codec, block).has(id), 'Implicit action has contradictory packed user membership');
        decisions[index] = {origin, kind: 'native', nativeKind};
      } catch (error) {
        if (!(error instanceof WireCodecError)) throw error;
        decisions[index] = incomplete(origin, error);
      }
      return {schemaVersion: 1, decisions};
    },
  };
}
