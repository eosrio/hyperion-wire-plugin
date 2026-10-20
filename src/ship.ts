import {createWireValueCodec} from './codec/values.js';
import {parseWireAbi} from './codec/abi.js';
import {codecAssert} from './codec/errors.js';
import {BinaryReader, fromHex, plainObject, toHex} from './codec/binary.js';
import {resolveCodecProfile, type WireCodecProfile} from './profiles.js';
import {decodeWireShipDeltas} from './ship-deltas.js';
import {normalizeKvRecord, type KvSource} from './primitives.js';

/** A decoded transport bundle retains its original frame and all nested raw bytes. */
export interface WireShipBundle {
  profileId: string;
  rawFrameHex: string;
  envelope: unknown;
  block?: unknown;
  traces?: unknown;
  deltas?: unknown;
  deltaRows?: {stream: string; present: number; rawHex: string; value: unknown}[];
  deltaFraming?: {declaredCount: number; actualCount: number; compatibility: string | null};
}

/**
 * Decode the advertised SHiP schema using the selected Wire scalar profile.
 * Canonical chain/fork selection belongs to the host, not this binary codec.
 */
export function createWireShipCodec(handshake: unknown, profile: WireCodecProfile = resolveCodecProfile()) {
  const abi = parseWireAbi(handshake);
  const codec = createWireValueCodec(abi, profile);
  codecAssert(abi.variants?.some(entry => entry.name === 'request')
    && abi.variants.some(entry => entry.name === 'result'), 'SHiP request/result variants are required', 'invalid_abi');
  function decodeDeltaRows(deltas: unknown) {
    codecAssert(Array.isArray(deltas), 'Invalid SHiP delta collection');
    return deltas.flatMap(delta => {
      codecAssert(Array.isArray(delta) && delta.length === 2, 'Invalid table_delta variant');
      const table = plainObject(delta[1]);
      codecAssert(typeof table.name === 'string' && Array.isArray(table.rows), 'Invalid delta stream');
      const stream = table.name;
      return table.rows.map(input => {
        const row = plainObject(input);
        codecAssert(typeof row.present === 'number', 'Invalid delta presence flag');
        const bytes = fromHex(row.data);
        return {stream, present: row.present, rawHex: toHex(bytes), value: codec.decode(stream, bytes)};
      });
    });
  }
  return {
    encodeRequest(request: unknown): Uint8Array { return codec.encode('request', request); },
    decodeRequest(bytes: Uint8Array): unknown { return codec.decode('request', bytes); },
    decodeResult(bytes: Uint8Array): unknown { return codec.decode('result', bytes); },
    decodeBlock(bytes: Uint8Array): unknown { return codec.decode('signed_block', bytes); },
    decodeTraces(bytes: Uint8Array): unknown { return codec.decode('transaction_trace[]', bytes); },
    decodeDeltas(bytes: Uint8Array) { return decodeWireShipDeltas(abi, bytes, profile); },
    decodeDeltaRows,
    normalizeKvRow(stream: 'contract_row_kv' | 'contract_index_kv', present: boolean, bytes: Uint8Array, source: KvSource) {
      const decoded = codec.decode(stream, bytes);
      codecAssert(Array.isArray(decoded) && decoded.length === 2 && decoded[0] === `${stream}_v0`, 'Unsupported KV row version', 'unsupported_feature');
      const row = plainObject(decoded[1]);
      const rawName = (value: unknown) => new BinaryReader(codec.encode('name', value)).uint(8).toString();
      const common = {present, code: rawName(row.code), payer: rawName(row.payer), tableId: row.table_id};
      const record = stream === 'contract_row_kv'
        ? {...common, kind: stream, keyHex: row.key, valueHex: row.value}
        : {...common, kind: stream, secondaryKeyHex: row.sec_key, primaryKeyHex: row.pri_key};
      return {...normalizeKvRecord(record, source), rawHex: toHex(bytes), decoded};
    },
    decodeBundle(bytes: Uint8Array): WireShipBundle {
      const envelope = codec.decode('result', bytes);
      const bundle: WireShipBundle = {profileId: profile.id, rawFrameHex: toHex(bytes), envelope};
      codecAssert(Array.isArray(envelope) && envelope.length === 2, 'Invalid SHiP result envelope');
      const name = envelope[0];
      if (typeof name !== 'string' || !name.startsWith('get_blocks_result_')) return bundle;
      const result = plainObject(envelope[1]);
      if (result.block !== null && result.block !== undefined) bundle.block = codec.decode('signed_block', fromHex(result.block));
      if (result.traces !== null && result.traces !== undefined) bundle.traces = codec.decode('transaction_trace[]', fromHex(result.traces));
      if (result.deltas !== null && result.deltas !== undefined) {
        const decoded = decodeWireShipDeltas(abi, fromHex(result.deltas), profile);
        bundle.deltas = decoded.deltas;
        bundle.deltaFraming = decoded.framing;
        bundle.deltaRows = decodeDeltaRows(bundle.deltas);
      }
      return bundle;
    },
  };
}
