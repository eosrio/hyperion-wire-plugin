/** Explicit API normalizations: wide integers are always decimal strings and
 * bool follows abi_serializer's uint8 value. No field-name or value guessing. */
export function normalizeOracle(value, type, abi, depth = 0) {
  if (depth > 64) throw new Error('Oracle normalization depth exceeded');
  const visit = (v, t) => normalizeOracle(v, t, abi, depth + 1);
  if (type.startsWith('protobuf::')) return value;
  if (type.endsWith('$')) return value === undefined ? undefined : visit(value, type.slice(0, -1));
  if (type.endsWith('?')) return value === null ? null : visit(value, type.slice(0, -1));
  const array = /^(.*)\[(\d*)\]$/.exec(type);
  if (array) return value.map(item => visit(item, array[1]));
  const alias = abi.types?.find(entry => entry.new_type_name === type);
  if (alias) return visit(value, alias.type);
  if (/^(u?int(64|128)|varint_u?int64)$/.test(type)) return String(value);
  if (type === 'bool') return Number(value);
  if (type === 'extended_asset') return {...value, quantity: visit(value.quantity, 'asset'), contract: visit(value.contract, 'name')};
  const enumeration = abi.enums?.find(entry => entry.name === type);
  if (enumeration) return typeof value === 'number' ? visit(value, enumeration.type) : value;
  const variant = abi.variants?.find(entry => entry.name === type);
  if (variant) return [value[0], visit(value[1], value[0])];
  const struct = abi.structs?.find(entry => entry.name === type);
  // Reflected builtins in real contract ABIs must not override runtime leaves.
  if (struct && !['slug_name', 'name', 'asset', 'symbol', 'time_point', 'block_timestamp_type', 'varint_int64', 'varint_uint64'].includes(type)) {
    const result = struct.base ? visit(value, struct.base) : {};
    for (const field of struct.fields) if (Object.hasOwn(value, field.name)) result[field.name] = visit(value[field.name], field.type);
    return result;
  }
  if (type === 'slug_name' && value && typeof value === 'object') return {value: String(value.value)};
  return value;
}

export function normalizeAbiOracle(value) {
  const result = structuredClone(value);
  delete result.____comment;
  for (const key of ['types', 'structs', 'actions', 'tables', 'ricardian_clauses', 'error_messages', 'abi_extensions', 'variants', 'action_results', 'enums']) result[key] ??= [];
  for (const item of result.error_messages) item.error_code = String(item.error_code);
  for (const item of result.enums) for (const member of item.values) member.value = String(member.value);
  if (typeof result.protobuf_types === 'string') result.protobuf_types = result.protobuf_types ? JSON.parse(result.protobuf_types) : undefined;
  if (result.protobuf_types === undefined) delete result.protobuf_types;
  return result;
}
