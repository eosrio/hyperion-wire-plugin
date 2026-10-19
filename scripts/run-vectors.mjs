import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  normalizeKvRecord, slotToUnixMilliseconds, unixMillisecondsToSlot, WireProtocolError,
} from '../dist/index.js';

const fixturePath = process.argv[2] ?? new URL('../fixtures/protocol-vectors.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const profile = JSON.parse(await readFile(new URL('../protocol-profile.json', import.meta.url), 'utf8'));
assert.equal(fixture.schemaVersion, 1);
assert.deepEqual(fixture.profile, profile);

const output = fixture.vectors.map(vector => {
  try {
    let result;
    switch (vector.operation) {
      case 'slotToUnixMilliseconds': result = slotToUnixMilliseconds(vector.input); break;
      case 'unixMillisecondsToSlot': result = unixMillisecondsToSlot(vector.input); break;
      case 'normalizeKvRecord': result = normalizeKvRecord(vector.input?.record, vector.input?.source); break;
      default: throw new Error(`Unsupported vector operation: ${vector.operation}`);
    }
    return {id: vector.id, result};
  } catch (error) {
    if (!(error instanceof WireProtocolError)) throw error;
    return {id: vector.id, error: error.code};
  }
});
process.stdout.write(`${JSON.stringify(output)}\n`);
