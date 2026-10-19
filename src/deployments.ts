import {decodeWireAbi, type WireAbi, type WireTableDef, type WireIndexDef} from './codec/abi.js';
import {createWireValueCodec} from './codec/values.js';
import {codecAssert} from './codec/errors.js';
import {fromHex, integer, plainObject, toHex} from './codec/binary.js';
import {normalizeKvRecord, type KvRecord, type KvSource} from './primitives.js';
import {resolveCodecProfile} from './profiles.js';

export interface WirePosition {blockNum: number; ordinal: number}
export interface WireAbiDeployment {
  id: string;
  chainId: string;
  /** Raw account uint64, independent of its display spelling. */
  contract: string;
  /** Inclusive position at which this ABI applies. */
  from: WirePosition;
  /** Exclusive end; omit only for the final deployment in this supplied view. */
  until?: WirePosition;
  abiHex: string;
  profileId: string;
}

const hex64 = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function position(value: unknown): WirePosition {
  const input = plainObject(value, 'invalid_abi');
  return {blockNum: Number(integer(input.blockNum, 32)), ordinal: Number(integer(input.ordinal, 32))};
}
function compare(left: WirePosition, right: WirePosition): number {
  return left.blockNum === right.blockNum ? left.ordinal - right.ordinal : left.blockNum - right.blockNum;
}

/**
 * A snapshot of deployments supplied by the host's canonical view. This class
 * checks scope and interval selection; it does not prove that view is canonical.
 * Missing, overlapping, or mismatched selections never fall back to a head ABI.
 */
export function createWireDeploymentRegistry(inputs: readonly WireAbiDeployment[]) {
  codecAssert(Array.isArray(inputs) && inputs.length <= 100_000, 'Invalid deployment collection', 'invalid_abi');
  const deployments = inputs.map(entry => {
    const value = plainObject(entry, 'invalid_abi');
    codecAssert(typeof value.id === 'string' && value.id.length > 0 && hex64(value.chainId), 'Invalid deployment scope', 'invalid_abi');
    codecAssert(typeof value.contract === 'string' && integer(value.contract, 64).toString() === value.contract, 'Invalid raw contract identity', 'invalid_abi');
    codecAssert(typeof value.profileId === 'string', 'Missing deployment profile', 'invalid_abi');
    const profile = resolveCodecProfile(value.profileId);
    const abiBytes = fromHex(value.abiHex);
    const from = position(value.from);
    const until = value.until === undefined ? undefined : position(value.until);
    codecAssert(!until || compare(from, until) < 0, 'Empty deployment interval', 'invalid_abi');
    return {id: value.id, chainId: value.chainId as string, contract: value.contract,
      from, until, profile, abiHex: toHex(abiBytes), abi: decodeWireAbi(abiBytes, profile)};
  });
  codecAssert(new Set(deployments.map(entry => entry.id)).size === deployments.length, 'Duplicate deployment identity', 'invalid_abi');
  function select(record: KvRecord, source: KvSource) {
    const candidates = deployments.filter(entry => entry.chainId === source.chainId && entry.contract === record.code
      && compare(entry.from, source) <= 0 && (!entry.until || compare(source, entry.until) < 0));
    codecAssert(candidates.length === 1, candidates.length ? 'Ambiguous ABI deployment' : 'Missing ABI deployment', 'invalid_abi');
    const selected = candidates[0]!;
    codecAssert(selected.id === source.abiDeployment, 'Source ABI deployment does not match its position', 'invalid_abi');
    return selected;
  }
  function mapping(abi: WireAbi, record: KvRecord): {table: WireTableDef; index?: WireIndexDef} {
    const matches: {table: WireTableDef; index?: WireIndexDef}[] = [];
    for (const table of abi.tables) {
      if (record.kind === 'contract_row_kv' && table.table_id === record.tableId) matches.push({table});
      if (record.kind === 'contract_index_kv') for (const index of table.secondary_indexes) {
        if (index.table_id === record.tableId) matches.push({table, index});
      }
    }
    codecAssert(matches.length === 1, matches.length ? 'Ambiguous numeric table mapping' : 'Missing numeric table mapping', 'invalid_abi');
    return matches[0]!;
  }
  return {
    decodeKvRecord(record: KvRecord, source: KvSource) {
      const normalized = normalizeKvRecord(record, source);
      const selected = select(normalized.record, normalized.source);
      const {table, index} = mapping(selected.abi, normalized.record);
      const result = {...normalized, profileId: selected.profile.id, abiHex: selected.abiHex,
        tableName: table.name, primaryTableId: table.table_id, valueType: table.type,
        ...(index ? {secondaryName: index.name, secondaryKeyType: index.key_type} : {})};
      // A removed row may carry no value. Its complete physical identity and
      // deployment mapping are still retained; key order encoding stays opaque.
      return normalized.record.kind === 'contract_row_kv' && normalized.record.present
        ? {...result, value: createWireValueCodec(selected.abi, selected.profile).decode(table.type, fromHex(normalized.record.valueHex))}
        : result;
    },
  };
}
