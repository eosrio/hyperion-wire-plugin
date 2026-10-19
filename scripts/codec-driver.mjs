import {readFile} from 'node:fs/promises';
import {decodeWireAbi, encodeWireAbi, createWireValueCodec, decodeWireShipDeltas, resolveCodecProfile, WireCodecError} from '../dist/index.js';

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
