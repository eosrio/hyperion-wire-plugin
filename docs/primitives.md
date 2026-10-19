# Wire engineering primitives

These package-local functions implement a bounded part of [issue #1](https://github.com/eosrio/hyperion-wire-plugin/issues/1).
They are not a generic SDK provider ABI. The profile identifies source-derived engineering fixtures;
it does not select a testnet launch build or claim support for every feature of that source revision.

`slotToUnixMilliseconds(slot)` accepts an integer in `0..4294967295`. The epoch is
`1735689600000` milliseconds and each slot is `500` milliseconds. `unixMillisecondsToSlot(ms)`
requires a safe integer in the corresponding range, aligned exactly to a slot.

`normalizeKvRecord(record, source)` validates and snapshots the complete supported primitive
shape. The input has already been decoded by a future protocol codec. Both row and index records
require `kind`, boolean `present`, raw `code` and `payer` as canonical uint64 decimal strings,
and integer `tableId` in `0..65535`. Rows retain lowercase even-length `keyHex` and `valueHex`;
indexes retain `secondaryKeyHex` and `primaryKeyHex`. Empty byte sequences remain empty. Deletes
retain the supplied bytes and payer; this function does not interpret tombstone storage behavior.

Source provenance requires lowercase 64-character `chainId` and `blockId`, positive uint32
`blockNum`, uint32 `ordinal`, and nonempty Unicode `abiDeployment` without leading/trailing
whitespace. The explicit boundary set is U+0009–000D, U+0020, U+0085, U+00A0, U+1680,
U+2000–200A, U+2028–2029, U+202F, U+205F, U+3000 and U+FEFF. Unpaired UTF-16 surrogates are
invalid. Supplying deployment provenance does not prove that the host resolved the canonical ABI.
The host must validate that binding before decoding. No field is coerced; extra fields fail
explicitly so an adapter cannot silently drop unmodeled source data.

The result is `{identity, record, source}`. The unambiguous identities are:

```text
wire-kv-v1:row:<chainId>:<code>:<tableId>:<keyHex>
wire-kv-v1:index:<chainId>:<code>:<tableId>:<secondaryKeyHex>:<primaryKeyHex>
```

Validated components contain no colons. Payer, value, presence, block position and ABI deployment
are retained separately and do not change the identity of an existing physical key. Secondary
IDs belong to their own index namespaces. No table ID is recomputed from a name, and decoded
display keys never substitute for raw bytes. Callers may add a projection namespace externally.
These logical identities are not Elasticsearch document IDs: a future storage adapter must choose
a physical key representation that respects backend limits without losing the complete identity.
Existing Antelope history identifiers are unchanged.

Invalid inputs have stable codes `invalid_slot`, `invalid_timestamp`, `invalid_record` and
`invalid_source`. Record validation precedes source validation. Node exports `WireProtocolError`;
Rust returns its corresponding typed error. The shared JSON runners compare results and error
codes. JavaScript-only tests additionally cover non-JSON inputs and object snapshots.

Node uses strict plain data objects; Rust consumes validated JSON values. A single private source
bundle includes the emitted Node exports/declarations, profile, Rust component and shared fixtures.
The development checks validate that bundle's contents. They do not implement a native ABI,
platform binary installer, catalog upgrade or live activation workflow.
