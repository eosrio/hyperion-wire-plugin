import {createHash} from 'node:crypto';
import type {ProtocolBlockAbiSource, ProtocolNativeGenesisFacts, ProtocolNativeGenesisInput} from '@eosrio/hyperion-sdk/protocol';
import {BinaryReader, fromHex, integer, plainObject} from './codec/binary.js';
import {codecAssert} from './codec/errors.js';
import {createWireValueCodec} from './codec/values.js';
import {nativeActionProfileId, resolveCodecProfile, type WireCodecProfile} from './profiles.js';
import {createWireShipCodec} from './ship.js';

// All constants follow wire-sysio6508c9e8; see docs/native-genesis.md.
const zero = '0'.repeat(64);
const schemaHash = '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9';
const nativeAbiHash = 'a57bc540b5c9d585cb20db92fff94e007c8dc3233c6e5bad3251c2701318e3d9';
const names = ['sysio', 'sysio.null', 'sysio.prods'] as const;
const inventory = [['account', 3], ['account_metadata', 1], ['global_property', 1], ['protocol_state', 1],
  ['permission', 9], ['resource_limits', 3], ['resource_usage', 3], ['resource_limits_state', 1], ['resource_limits_config', 1]] as const;
const wasmDefaults = {max_mutable_global_bytes: 1024, max_table_elements: 1024, max_section_elements: 8192,
  max_linear_memory_init: 65536, max_func_local_bytes: 8192, max_nested_structures: 1024, max_symbol_bytes: 8192,
  max_module_bytes: 20971520, max_code_bytes: 20971520, max_pages: 528, max_call_depth: 251};
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
// Compare decoded portable values, independent of the inert reader's null prototype.
function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (Array.isArray(actual)) return Array.isArray(expected) && actual.length === expected.length
    && actual.every((value, index) => sameValue(value, expected[index]));
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object' || Array.isArray(expected)) return false;
  const left = actual as Record<string, unknown>, right = expected as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}
const requireEqual = (actual: unknown, expected: unknown, label: string) =>
  codecAssert(sameValue(actual, expected), `Invalid native genesis ${label}`);
function variant(value: unknown, tag: string): Record<string, unknown> {
  codecAssert(Array.isArray(value) && value.length === 2 && value[0] === tag, `Unsupported native genesis ${tag}`, 'unsupported_feature');
  return plainObject(value[1]);
}
function boundedBytes(value: unknown, maximum: number): Uint8Array {
  codecAssert(value instanceof Uint8Array && value.byteLength > 0, 'Native genesis requires original byte sections');
  codecAssert(value.byteLength <= maximum, 'Native genesis byte limit', 'limits_exceeded');
  return Uint8Array.prototype.slice.call(value) as Uint8Array;
}

/** The pinned genesis validates configuration, independently from initial resource defaults. */
function validateConfiguration(config: Record<string, unknown>) {
  const n = (name: string) => integer(config[name], name === 'max_block_net_usage' ? 64 : 32);
  for (const name of ['target_block_net_usage_pct', 'target_block_cpu_usage_pct']) {
    codecAssert(n(name) >= 10n && n(name) <= 10000n, 'Invalid native genesis target percentage');
  }
  codecAssert(n('max_transaction_net_usage') >= 10240n && n('max_transaction_net_usage') < n('max_block_net_usage'), 'Invalid native genesis NET configuration');
  codecAssert(n('context_free_discount_net_usage_den') > 0n
    && n('context_free_discount_net_usage_num') <= n('context_free_discount_net_usage_den'), 'Invalid native genesis discount');
  codecAssert(n('min_transaction_cpu_usage') <= n('max_transaction_cpu_usage')
    && n('max_transaction_cpu_usage') < n('max_block_cpu_usage')
    && n('max_transaction_cpu_usage') < n('max_block_cpu_usage') - n('min_transaction_cpu_usage'), 'Invalid native genesis CPU configuration');
  codecAssert(n('max_authority_depth') >= 1n && n('max_action_return_value_size') <= 20n * 1024n * 1024n, 'Invalid native genesis configuration limits');
  for (const name of ['max_kv_key_size', 'max_kv_secondary_key_size', 'max_kv_value_size']) {
    codecAssert(n(name) >= 1n && n(name) <= (name === 'max_kv_value_size' ? 1048576n : 1024n), 'Invalid native genesis KV configuration');
  }
}

function checkPermissions(rows: Record<string, unknown>[], timestamp: unknown,
                          encodeKey: (value: unknown) => Uint8Array) {
  const first = plainObject(rows[1]!.auth);
  codecAssert(Array.isArray(first.keys) && first.keys.length === 1, 'Missing native genesis producer key');
  const key = plainObject(first.keys[0]).key;
  codecAssert(typeof key === 'string', 'Invalid native genesis producer key');
  const encoded = encodeKey(key), carrier = new BinaryReader(encoded);
  // Source authority.hpp stores K1/R1/EM/ED inline; their aligned billing is identical.
  // Heap-backed WA/BLS genesis billing is deliberately not admitted in this first slice.
  codecAssert([0, 1, 3, 4].includes(carrier.varuint()), 'Unsupported native genesis heap-key billing', 'unsupported_feature');
  const empty = {threshold: 1, keys: [], accounts: [], waits: []};
  const system = {...empty, keys: [{key, weight: 1}]};
  const producers = {...empty, accounts: [{permission: {actor: 'sysio', permission: 'active'}, weight: 1}]};
  const permission = (owner: string, name: string, parent: string, auth: unknown) =>
    ({owner, name, parent, last_updated: timestamp, auth});
  const expected = [{owner: '', name: '', parent: '', last_updated: '1970-01-01T00:00:00.000',
    auth: {threshold: 0, keys: [], accounts: [], waits: []}},
  permission('sysio', 'owner', '', system), permission('sysio', 'active', 'owner', system),
  permission('sysio.null', 'owner', '', empty), permission('sysio.null', 'active', 'owner', empty),
  permission('sysio.prods', 'owner', '', empty), permission('sysio.prods', 'active', 'owner', producers),
  permission('sysio.prods', 'prod.major', 'active', producers), permission('sysio.prods', 'prod.minor', 'prod.major', producers)];
  requireEqual(rows, expected, 'permissions');
}

function checkResources(group: (name: string) => Record<string, unknown>[]) {
  const accumulator = () => ['usage_accumulator_v0', {last_ordinal: 0, value_ex: '0', consumed: '0'}];
  requireEqual(group('resource_limits'), names.map(owner => ({owner, net_weight: '-1', cpu_weight: '-1', ram_bytes: '-1'})), 'resource limits');
  // controller::create_native_account source billing: null816, prods+32, sysio+160+2063+128.
  const ram = ['3167', '816', '848'];
  requireEqual(group('resource_usage'), names.map((owner, index) =>
    ({owner, net_usage: accumulator(), cpu_usage: accumulator(), ram_usage: ram[index]})), 'resource usage');
  requireEqual(group('resource_limits_state'), [{average_block_net_usage: accumulator(), average_block_cpu_usage: accumulator(),
    total_net_weight: '0', total_cpu_weight: '0', total_ram_bytes: '0', virtual_net_limit: '1048576', virtual_cpu_limit: '200000'}], 'resource state');
  const parameters = (target: string, max: string) => ['elastic_limit_parameters_v0', {target, max, periods: 120, max_multiplier: 1000,
    contract_rate: ['resource_limits_ratio_v0', {numerator: '99', denominator: '100'}],
    expand_rate: ['resource_limits_ratio_v0', {numerator: '1000', denominator: '999'}]}];
  requireEqual(group('resource_limits_config'), [{cpu_limit_parameters: parameters('20000', '200000'),
    net_limit_parameters: parameters('104857', '1048576'), account_cpu_usage_average_window: 172800,
    account_net_usage_average_window: 172800}], 'resource configuration');
}

/** Pure source-semantic facts only. Host source binding/reverification governs authority. */
export function verifyWireNativeGenesis(inputValue: ProtocolNativeGenesisInput, sourceValue: ProtocolBlockAbiSource,
                                        profile: WireCodecProfile): ProtocolNativeGenesisFacts {
  const canonical = resolveCodecProfile(profile.id === nativeActionProfileId
    ? profile.id : 'wire-sysio-6508c9e8-engineering-v1');
  codecAssert(Object.entries(canonical).every(([key, value]) => profile[key as keyof WireCodecProfile] === value),
    'Unsupported native genesis profile', 'unsupported_feature');
  const input = plainObject(inputValue), source = plainObject(sourceValue);
  requireEqual(Object.keys(input).sort(), ['block', 'deltas', 'schemaJson', 'traces'], 'input fields');
  requireEqual(Object.keys(source).sort(), ['blockId', 'blockNum', 'chainId', 'previousBlockId'], 'source fields');
  codecAssert(source.blockNum === 1 && source.previousBlockId === null && typeof source.chainId === 'string'
    && /^[0-9a-f]{64}$/.test(source.chainId) && typeof source.blockId === 'string' && /^[0-9a-f]{64}$/.test(source.blockId), 'Invalid native genesis source');
  codecAssert(input.traces === null, 'Native genesis requires the original absent trace section');
  codecAssert(typeof input.schemaJson === 'string', 'Native genesis requires original schema text');
  codecAssert(input.schemaJson.length <= 65536, 'Native genesis schema limit', 'limits_exceeded');
  codecAssert(hash(input.schemaJson) === schemaHash, 'Native genesis schema does not match pinned source', 'invalid_abi');
  const blockBytes = boundedBytes(input.block, 1024), deltaBytes = boundedBytes(input.deltas, 65536);
  const schema = JSON.parse(input.schemaJson) as unknown;
  const codec = createWireValueCodec(schema, profile), ship = createWireShipCodec(schema, profile);
  const block = plainObject(ship.decodeBlock(blockBytes));
  const header = {timestamp: block.timestamp, producer: '', previous: zero, transaction_mroot: zero, finality_mroot: zero,
    qc_claim: {block_num: 0, is_strong_qc: 0}, new_finalizer_policy_diff: null, new_proposer_policy_diff: null,
    header_extensions: []};
  requireEqual(block, {...header, producer_signatures: [], transactions: [], qc: null, block_extensions: []}, 'header');
  const id = createHash('sha256').update(codec.encode('block_header', header)).digest();
  id.writeUInt32BE(1, 0);
  codecAssert(id.toString('hex') === source.blockId, 'Native genesis header/source ID mismatch');
  const decoded = ship.decodeDeltas(deltaBytes);
  requireEqual(decoded.framing, {declaredCount: 8, actualCount: 9, compatibility: 'wire-resource-index-count-v1'}, 'delta framing');
  codecAssert(Array.isArray(decoded.deltas), 'Invalid native genesis deltas');
  requireEqual(decoded.deltas.map(delta => {
    const table = variant(delta, 'table_delta_v0');
    codecAssert(Array.isArray(table.rows), 'Invalid native genesis row array');
    return [table.name, table.rows.length];
  }), inventory.map(([name, count]) => [name, count]), 'physical inventory');
  const rows = ship.decodeDeltaRows(decoded.deltas);
  const values = rows.map(row => {
    codecAssert(row.present === 1, 'Native genesis cannot contain tombstones');
    return {stream: row.stream, value: variant(row.value, row.stream === 'global_property' ? 'global_property_v1' : `${row.stream}_v0`)};
  });
  const group = (name: string) => values.filter(row => row.stream === name).map(row => row.value);
  const accounts = group('account');
  const creationDate = new Date(profile.epochMilliseconds).toISOString().slice(0, -1);
  for (const [index, account] of accounts.entries()) {
    codecAssert(typeof account.abi === 'string', 'Invalid native genesis ABI');
    requireEqual(account, {name: names[index], creation_date: creationDate, abi: account.abi}, 'account');
    if (index === 0) {
      const abi = fromHex(account.abi);
      codecAssert(abi.length === 2063 && hash(abi) === nativeAbiHash, 'Native genesis ABI does not match compiled source');
    } else requireEqual(account.abi, '', 'empty ABI barrier');
  }
  requireEqual(group('account_metadata'), [{name: 'sysio', privileged: 1, last_code_update: '1970-01-01T00:00:00.000', code: null}], 'account metadata');
  const global = group('global_property')[0]!;
  requireEqual(global, {proposed_schedule_block_num: 0, proposed_schedule: {version: 0, producers: []},
    configuration: global.configuration, chain_id: source.chainId, wasm_configuration: ['wasm_config_v0', wasmDefaults]}, 'global property');
  validateConfiguration(variant(global.configuration, 'chain_config_v0'));
  requireEqual(group('protocol_state'), [{activated_protocol_features: []}], 'protocol state');
  checkPermissions(group('permission'), block.timestamp, key => codec.encode('public_key', key));
  checkResources(group);
  return Object.freeze({schemaVersion: 1, previousBlockId: zero, applicationState: 'empty',
    abiStates: Object.freeze(accounts.map((account, deltaOrdinal) => Object.freeze({account: account.name as string,
      present: true, abiHex: account.abi as string, deltaOrdinal})))});
}
