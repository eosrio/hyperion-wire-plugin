import {readFile} from 'node:fs/promises';
import {decodeWireAbi, encodeWireAbi, createWireValueCodec, createWireNativeActions, decodeWireShipDeltas, resolveCodecProfile, WireCodecError} from '../dist/index.js';
import {createProtocolProvider} from '../dist/provider.js';
import {fromHex} from '../dist/codec/binary.js';

let source = '';
if (process.argv[2]) source = await readFile(process.argv[2], 'utf8');
else { process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) source += chunk; }
const input = JSON.parse(source);
if (!Array.isArray(input)) throw new Error('Expected a JSON array of codec operations');
const output = input.map(operation => {
  try {
    const profile = resolveCodecProfile(operation.profileId);
    const bytes = () => {
      if (typeof operation.hex !== 'string' || operation.hex.length % 2 || !/^[0-9a-f]*$/.test(operation.hex)) throw new WireCodecError('invalid_value', 'Invalid hex');
      return new Uint8Array(Buffer.from(operation.hex, 'hex'));
    };
    let result;
    switch (operation.operation) {
      case 'decodeAbi': result = decodeWireAbi(bytes(), profile); break;
      case 'encodeAbi': result = Buffer.from(encodeWireAbi(operation.abi, profile)).toString('hex'); break;
      case 'decodeValue': result = createWireValueCodec(operation.abi, profile).decode(operation.typeName, bytes()); break;
      case 'decodeDeltas': result = decodeWireShipDeltas(operation.abi, bytes(), profile); break;
      case 'encodeValue': result = Buffer.from(createWireValueCodec(operation.abi, profile).encode(operation.typeName, operation.value)).toString('hex'); break;
      case 'decode_native_value': result = createWireNativeActions(profile).decodeValue(operation.nativeKind, bytes()); break;
      case 'encode_native_value': result = Buffer.from(createWireNativeActions(profile).encodeValue(operation.nativeKind, operation.value)).toString('hex'); break;
      case 'observe_native_actions': {
        const value = operation.input;
        // Translate only the documented JSON transport. Never drop unknown keys
        // or coerce malformed sections into a successful source observation.
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).sort().join(',') !== 'blockHex,schemaJson,tracesHex') {
          throw new WireCodecError('invalid_value', 'Invalid native input fields');
        }
        for (const name of ['blockHex', 'tracesHex']) {
          if (typeof value[name] !== 'string' || value[name].length % 2 || !/^[0-9a-f]*$/i.test(value[name])) {
            throw new WireCodecError('invalid_value', 'Invalid native input hex');
          }
        }
        result = createWireNativeActions(profile).observe({schemaJson: value.schemaJson,
          block: fromHex(value.blockHex), traces: fromHex(value.tracesHex)}, operation.source);
        break;
      }
      case 'observe_block_abi': {
        const value = operation.input;
        const accountRows = Array.isArray(value?.accountRows)
          ? value.accountRows.map(row => row && typeof row === 'object' && !Array.isArray(row)
            ? {ordinal: row.ordinal, present: row.present, raw: fromHex(row.rawHex), value: row.value} : row)
          : value?.accountRows;
        result = createProtocolProvider(profile.id).observeBlockAbi({traces: value?.traces, accountRows}, operation.source);
        break;
      }
      default: throw new Error('Unsupported codec operation');
    }
    return {result};
  } catch (error) {
    if (error instanceof WireCodecError) return {error: error.code};
    if (error instanceof RangeError && error.message === 'Unknown Wire codec profile') return {error: 'unsupported_feature'};
    throw error;
  }
});
process.stdout.write(JSON.stringify(output) + '\n');
