/** Package-local primitives for the pinned Wire engineering fixture profile. */
const EPOCH_MILLISECONDS = 1_735_689_600_000;
const SLOT_MILLISECONDS = 500;
const MAX_UINT32 = 4_294_967_295;
const MAX_UINT16 = 65_535;
const MAX_UINT64_DECIMAL = '18446744073709551615';
const LAST_SLOT_MILLISECONDS = EPOCH_MILLISECONDS + MAX_UINT32 * SLOT_MILLISECONDS;

export type WireProtocolErrorCode =
  | 'invalid_slot'
  | 'invalid_timestamp'
  | 'invalid_record'
  | 'invalid_source';

export class WireProtocolError extends Error {
  readonly code: WireProtocolErrorCode;

  constructor(code: WireProtocolErrorCode, message: string) {
    super(message);
    this.name = 'WireProtocolError';
    this.code = code;
  }
}

export interface RowKvRecord {
  kind: 'contract_row_kv';
  present: boolean;
  /** Raw sysio name value as canonical unsigned uint64 decimal. */
  code: string;
  /** Raw sysio name value as canonical unsigned uint64 decimal. */
  payer: string;
  tableId: number;
  keyHex: string;
  valueHex: string;
}

export interface IndexKvRecord {
  kind: 'contract_index_kv';
  present: boolean;
  /** Raw sysio name value as canonical unsigned uint64 decimal. */
  code: string;
  /** Raw sysio name value as canonical unsigned uint64 decimal. */
  payer: string;
  tableId: number;
  secondaryKeyHex: string;
  primaryKeyHex: string;
}

export type KvRecord = RowKvRecord | IndexKvRecord;

export interface KvSource {
  chainId: string;
  blockId: string;
  blockNum: number;
  ordinal: number;
  /** Supplied provenance; this primitive does not resolve canonical deployments. */
  abiDeployment: string;
}

export interface NormalizedKvRecord {
  identity: string;
  record: KvRecord;
  source: KvSource;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
}

export function slotToUnixMilliseconds(slot: unknown): number {
  if (!isIntegerInRange(slot, 0, MAX_UINT32)) {
    throw new WireProtocolError('invalid_slot', 'Expected an integer slot between 0 and 4294967295');
  }
  return EPOCH_MILLISECONDS + slot * SLOT_MILLISECONDS;
}

export function unixMillisecondsToSlot(milliseconds: unknown): number {
  if (!isIntegerInRange(milliseconds, EPOCH_MILLISECONDS, LAST_SLOT_MILLISECONDS)
    || (milliseconds - EPOCH_MILLISECONDS) % SLOT_MILLISECONDS !== 0) {
    throw new WireProtocolError('invalid_timestamp', 'Expected a safe integer timestamp aligned to a supported 500 ms slot');
  }
  return (milliseconds - EPOCH_MILLISECONDS) / SLOT_MILLISECONDS;
}

/** Snapshot own data properties only; validation never invokes field getters. */
function readShape(input: unknown, keys: readonly string[], code: WireProtocolErrorCode): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WireProtocolError(code, 'Expected an object with the exact supported fields');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WireProtocolError(code, 'Expected a plain object');
  }
  const properties = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(properties);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new WireProtocolError(code, 'Unexpected or missing fields');
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const property = properties[key];
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) {
      throw new WireProtocolError(code, 'Expected enumerable data fields');
    }
    result[key] = property.value;
  }
  return result;
}

function isUint64Decimal(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[^0-9]/.test(value)
    && (value === '0' || value[0] !== '0')
    && (value.length < MAX_UINT64_DECIMAL.length
      || (value.length === MAX_UINT64_DECIMAL.length && value <= MAX_UINT64_DECIMAL));
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && value.length % 2 === 0 && !/[^0-9a-f]/.test(value);
}

function readRecord(input: unknown): KvRecord {
  // Read kind as a data descriptor so an invalid accessor is never executed.
  const kind = typeof input === 'object' && input !== null
    ? Object.getOwnPropertyDescriptor(input, 'kind')?.value : undefined;
  const keys = kind === 'contract_row_kv'
    ? ['kind', 'present', 'code', 'payer', 'tableId', 'keyHex', 'valueHex']
    : ['kind', 'present', 'code', 'payer', 'tableId', 'secondaryKeyHex', 'primaryKeyHex'];
  const record = readShape(input, keys, 'invalid_record');
  if (typeof record.present !== 'boolean' || !isUint64Decimal(record.code)
    || !isIntegerInRange(record.tableId, 0, MAX_UINT16)) {
    throw new WireProtocolError('invalid_record', 'Invalid presence, account or table ID');
  }
  if (record.kind === 'contract_row_kv' && isUint64Decimal(record.payer)
    && isHex(record.keyHex) && isHex(record.valueHex)) {
    return {
      kind: record.kind, present: record.present, code: record.code, payer: record.payer,
      tableId: record.tableId, keyHex: record.keyHex, valueHex: record.valueHex,
    };
  }
  if (record.kind === 'contract_index_kv' && isUint64Decimal(record.payer)
    && isHex(record.secondaryKeyHex) && isHex(record.primaryKeyHex)) {
    return {
      kind: record.kind, present: record.present, code: record.code, payer: record.payer, tableId: record.tableId,
      secondaryKeyHex: record.secondaryKeyHex, primaryKeyHex: record.primaryKeyHex,
    };
  }
  throw new WireProtocolError('invalid_record', 'Unsupported record kind or invalid byte fields');
}

// Explicit shared set: JS and Rust trim differ for NEL and BOM.
const BOUNDARY_WHITESPACE = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$/u;

function readSource(input: unknown): KvSource {
  const source = readShape(input, ['chainId', 'blockId', 'blockNum', 'ordinal', 'abiDeployment'], 'invalid_source');
  if (!isHex(source.chainId) || source.chainId.length !== 64
    || !isHex(source.blockId) || source.blockId.length !== 64
    || !isIntegerInRange(source.blockNum, 1, MAX_UINT32)
    || !isIntegerInRange(source.ordinal, 0, MAX_UINT32)
    || typeof source.abiDeployment !== 'string' || source.abiDeployment.length === 0
    || BOUNDARY_WHITESPACE.test(source.abiDeployment) || /[\ud800-\udfff]/u.test(source.abiDeployment)) {
    throw new WireProtocolError('invalid_source', 'Invalid chain, block or ABI deployment provenance');
  }
  return {
    chainId: source.chainId, blockId: source.blockId, blockNum: source.blockNum,
    ordinal: source.ordinal, abiDeployment: source.abiDeployment,
  };
}

/** Preserve full decoded primitives and provenance; no binary decoding or ABI lookup occurs here. */
export function normalizeKvRecord(input: unknown, provenance: unknown): NormalizedKvRecord {
  // Record errors deliberately take precedence when both inputs are malformed.
  const record = readRecord(input);
  const source = readSource(provenance);
  const prefix = `wire-kv-v1:${record.kind === 'contract_row_kv' ? 'row' : 'index'}:${source.chainId}:${record.code}:${record.tableId}`;
  const identity = record.kind === 'contract_row_kv'
    ? `${prefix}:${record.keyHex}`
    : `${prefix}:${record.secondaryKeyHex}:${record.primaryKeyHex}`;
  return {identity, record, source};
}
