import type {ProtocolProvider, ProtocolShipSession} from '@eosrio/hyperion-sdk/protocol';
import {decodeWireAbi, encodeWireAbi, type WireAbi} from './codec/abi.js';
import {BinaryReader, fromHex, plainObject, toHex} from './codec/binary.js';
import {codecAssert} from './codec/errors.js';
import {createWireValueCodec} from './codec/values.js';
import {createWireDeploymentRegistry} from './deployments.js';
import {normalizeKvRecord} from './primitives.js';
import {resolveCodecProfile} from './profiles.js';
import {createWireShipCodec} from './ship.js';

// Source-pinned SHiP v0 physical KV layout; it is independent of contract ABIs.
// Tests compare these fields with the captured upstream handshake.
const kvAbi = {version: 'sysio::abi/1.3', structs: [
  {name: 'contract_row_kv_v0', base: '', fields: [
    {name: 'code', type: 'name'}, {name: 'payer', type: 'name'}, {name: 'table_id', type: 'uint16'},
    {name: 'key', type: 'bytes'}, {name: 'value', type: 'bytes'}]},
  {name: 'contract_index_kv_v0', base: '', fields: [
    {name: 'code', type: 'name'}, {name: 'payer', type: 'name'}, {name: 'table_id', type: 'uint16'},
    {name: 'sec_key', type: 'bytes'}, {name: 'pri_key', type: 'bytes'}]},
], variants: [
  {name: 'contract_row_kv', types: ['contract_row_kv_v0']},
  {name: 'contract_index_kv', types: ['contract_index_kv_v0']},
]};

const knownStreams = new Set(['account', 'account_metadata', 'code', 'contract_row_kv', 'contract_index_kv',
  'global_property', 'protocol_state', 'permission', 'permission_link', 'resource_limits', 'resource_usage',
  'resource_limits_state', 'resource_limits_config']);

/** Construct only after the host has verified the inert descriptor and installed artifact digests. */
export function createProtocolProvider(profileId: string): ProtocolProvider<WireAbi> {
  codecAssert(typeof profileId === 'string' && profileId.length > 0, 'An explicit Wire profile is required', 'unsupported_feature');
  const profile = resolveCodecProfile(profileId);
  const physical = createWireValueCodec(kvAbi, profile);
  const rawName = (value: unknown) => new BinaryReader(physical.encode('name', value)).uint(8).toString();
  return {
    profileId: profile.id,
    contractCodec: {
      decodeAbi: bytes => decodeWireAbi(bytes, profile),
      encodeAbi: abi => encodeWireAbi(abi, profile),
      decodeValue: (abi, type, bytes) => createWireValueCodec(abi, profile).decode(type, bytes),
      encodeValue: (abi, type, value) => createWireValueCodec(abi, profile).encode(type, value),
    },
    createShipSession(handshake: unknown): ProtocolShipSession {
      const ship = createWireShipCodec(handshake, profile);
      const codec = createWireValueCodec(handshake, profile);
      // Every session closes over its own schema. Reconnection cannot replace
      // the codecs of an existing session or another chain's provider.
      return {
        encodeRequest: request => ship.encodeRequest(request),
        decodeResult: bytes => ship.decodeResult(bytes),
        decodeBlock: bytes => ship.decodeBlock(bytes),
        decodeTraces: bytes => ship.decodeTraces(bytes),
        decodeDeltas: bytes => ship.decodeDeltas(bytes).deltas,
        decodeRow(stream, bytes) {
          codecAssert(knownStreams.has(stream), `Unsupported required Wire delta stream: ${stream}`, 'unsupported_feature');
          return codec.decode(stream, bytes);
        },
      };
    },
    normalizeDelta(input, context) {
      codecAssert(knownStreams.has(input.stream), `Unsupported required Wire delta stream: ${input.stream}`, 'unsupported_feature');
      codecAssert(typeof input.present === 'boolean', 'Invalid delta presence flag');
      if (input.stream !== 'contract_row_kv' && input.stream !== 'contract_index_kv') {
        return {kind: 'passthrough', value: input.value};
      }
      const decoded = physical.decode(input.stream, input.raw);
      codecAssert(toHex(physical.encode(input.stream, input.value)) === toHex(input.raw), 'Decoded KV row does not match its raw bytes');
      codecAssert(Array.isArray(decoded) && decoded.length === 2 && decoded[0] === `${input.stream}_v0`,
        'Unsupported physical KV version', 'unsupported_feature');
      const row = plainObject(decoded[1]);
      const source = {chainId: context.chainId, blockId: context.blockId, blockNum: context.blockNum,
        ordinal: context.ordinal, abiDeployment: context.abiDeployment?.id ?? 'pending'};
      const common = {present: input.present, code: rawName(row.code), payer: rawName(row.payer), tableId: row.table_id};
      const record = input.stream === 'contract_row_kv'
        ? {...common, kind: input.stream, keyHex: row.key, valueHex: row.value}
        : {...common, kind: input.stream, secondaryKeyHex: row.sec_key, primaryKeyHex: row.pri_key};
      const normalized = normalizeKvRecord(record, source);
      const deployment = context.abiDeployment;
      if (!deployment) return {kind: 'abi-required', account: row.code as string};
      codecAssert(toHex(encodeWireAbi(deployment.abi, profile)) === toHex(fromHex(deployment.abiHex)),
        'Selected ABI metadata does not match the supplied deployment bytes', 'invalid_abi');
      const registry = createWireDeploymentRegistry([{id: deployment.id, chainId: context.chainId, contract: normalized.record.code,
        from: deployment.from, ...(deployment.until ? {until: deployment.until} : {}), abiHex: deployment.abiHex, profileId: profile.id}]);
      const selected = registry.decodeKvRecord(normalized.record, source);
      return {kind: 'record', identity: selected.identity, record: selected.record, source: selected.source,
        tableName: selected.tableName, ...('value' in selected ? {value: selected.value} : {}), metadata: {
          profileId: profile.id, recordKind: input.stream === 'contract_row_kv' ? 'row' : 'index',
          present: input.present, code: row.code, payer: row.payer, rawHex: toHex(input.raw),
          primaryTableId: selected.primaryTableId, valueType: selected.valueType,
          ...('secondaryName' in selected ? {secondaryName: selected.secondaryName, secondaryKeyType: selected.secondaryKeyType} : {}),
        }};
    },
  };
}
