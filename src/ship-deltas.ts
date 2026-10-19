import {createWireValueCodec} from './codec/values.js';
import {BinaryReader, BinaryWriter, CODEC_LIMITS} from './codec/binary.js';
import {codecAssert, WireCodecError} from './codec/errors.js';
import {codecProfiles, type WireCodecProfile} from './profiles.js';

const streamOrder = ['account', 'account_metadata', 'code', 'contract_row_kv', 'contract_index_kv',
  'global_property', 'protocol_state', 'permission', 'permission_link', 'resource_limits', 'resource_usage',
  'resource_limits_state', 'resource_limits_config'];

/** Wire's pinned producer counts resource_index once but emits it twice.
 * Generic ABI decoding stays strict. This transport-specific correction is
 * accepted only for the evidenced source profiles and exact producer ordering. */
export function decodeWireShipDeltas(abi: unknown, bytes: Uint8Array, profile: WireCodecProfile) {
  const reader = new BinaryReader(bytes);
  const declaredCount = reader.count();
  const codec = createWireValueCodec(abi, profile);
  try {
    return {deltas: codec.decode('table_delta[]', bytes), framing: {declaredCount, actualCount: declaredCount, compatibility: null}};
  } catch (error) {
    if (!(error instanceof WireCodecError) || error.code !== 'invalid_value') throw error;
    codecAssert(codecProfiles.some(known => known.id === profile.id && known.upstreamRevision === profile.upstreamRevision), 'No delta framing correction for unknown profiles', 'unsupported_feature');
    codecAssert(declaredCount < CODEC_LIMITS.maxItems, 'Delta count limit', 'limits_exceeded');
    const writer = new BinaryWriter();
    writer.varuint(declaredCount + 1); writer.add(bytes.subarray(reader.offset));
    const deltas = codec.decode('table_delta[]', writer.finish());
    codecAssert(Array.isArray(deltas), 'Invalid corrected delta array');
    let previous = -1;
    const names = deltas.map(delta => {
      codecAssert(Array.isArray(delta) && delta[0] === 'table_delta_v0' && delta[1] !== null && typeof delta[1] === 'object', 'Unsupported corrected delta layout');
      const name = (delta[1] as {name?: unknown}).name;
      const index = typeof name === 'string' ? streamOrder.indexOf(name) : -1;
      codecAssert(index > previous, 'Corrected delta stream ordering mismatch');
      previous = index;
      return name;
    });
    codecAssert(names.includes('resource_limits') && names.includes('resource_usage'), 'Delta count correction requires both resource streams');
    return {deltas, framing: {declaredCount, actualCount: deltas.length, compatibility: 'wire-resource-index-count-v1'}};
  }
}
