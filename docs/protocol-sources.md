# Wire protocol primitive sources and limits

The profile in [protocol-profile.json](../protocol-profile.json) is an **engineering fixture
profile**, not a selected testnet launch profile or a supported plugin release. It pins
`Wire-Network/wire-sysio` at `6508c9e8f4044df8d5acb082a7af3be6a80cd9a0` so the
package-local primitives and their fixtures have a stable source reference.

This slice converts timestamp slots and constructs backend-neutral identities from a strict,
already-decoded KV input shape. It does not decode SHiP frames, binary contract ABIs, contract
values, enum values, protobuf messages, or `slug_name` values. It does not load a provider into
Hyperion, change existing Antelope history IDs, establish MongoDB/WormDB conformance, or qualify
live indexing, historical replay, ABI changes, fork rollback, or durability.

The accepted architecture requires one operator-managed package with coordinated Node/Rust
components and working Wire support qualified on a new testnet with Wire's contracts. These
engineering fixtures do not select the launch node build, CDT build, deployed contract set,
WASM/ABI digests, genesis/network identity, or extension release. Those remain separate work
under [qualification profile issue #22](https://github.com/eosrio/hyperion-tools/issues/22),
[ADR 0030](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/adr/0030-unified-chain-extension-package.md),
[ADR 0031](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/adr/0031-require-working-wire-support-for-45.md), and
[ADR 0032](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/adr/0032-qualify-wire-on-new-testnet-with-wire-contracts.md).

## Source facts used by this slice

| Fact | Pinned source | Consequence |
| --- | --- | --- |
| A block slot represents `1735689600000 + slot * 500` Unix milliseconds. The source slot is `uint32`. | [Configuration](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/include/sysio/chain/config.hpp#L40-L42), [timestamp conversion](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/include/sysio/chain/block_timestamp.hpp#L21-L47) | Preserve the 2025 epoch and 500 ms interval. Exact reverse conversion in this package rejects unaligned or out-of-range timestamps. |
| Primary KV uniqueness uses contract code, `uint16 table_id`, and every key byte. | [Primary object and ordered index](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/include/sysio/chain/kv_table_objects.hpp#L40-L107) | A decoded first field or display key cannot replace full raw-key identity. |
| Secondary uniqueness uses contract code, secondary namespace ID, secondary bytes, and primary bytes. | [Secondary object and ordered index](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/include/sysio/chain/kv_table_objects.hpp#L110-L185) | Equal secondary values with different primary keys remain separate entries. |
| The node emits primary and secondary KV streams with explicit IDs and raw bytes. | [SHiP schemas](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/state_history/abi.cpp#L325-L340), [binary serialization](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/state_history/include/sysio/state_history/serialization.hpp#L234-L261), [emission](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/state_history/create_deltas.cpp#L134-L137) | Keep the record kind and all supplied byte fields explicit; preserve deletion payloads. |

The package adds `chainId` to those source identities to prevent cross-chain collisions. Payer,
value, presence, ABI deployment identifier, block identity/number, and ordinal are retained
metadata and do not change a physical key identity. A host may add its projection namespace.
The supplied ABI deployment identifier is provenance only: this slice cannot prove it belongs
to the block or resolves the table correctly. Host integration must establish that binding.

The package-local row input retains code, payer, table ID, raw key/value, and presence. The
package-local index input retains code, payer, table ID, both keys, and presence. Payer is
required for both record kinds, retained verbatim, and excluded from identity. A future SHiP
adapter must also preserve the raw envelope context. These primitives receive decoded fields;
they are not a binary frame decoder or a complete host normalization adapter.

Code/payer decimal strings carry raw unsigned 64-bit name values, not display account names.
Hex strings carry exact bytes, not decoded key meanings. Empty byte strings and table ID zero
are deliberately permitted; interpreting a particular schema belongs to its codec. Record and
source properties outside the declared input shapes are rejected instead of silently discarded.

## Codec requirements that remain outstanding

- Wire's binary contract ABI has string table names, `uint16` table IDs, secondary-index
  definitions, trailing action results, enums, and protobuf descriptors. A legacy Antelope
  meta-ABI decoder cannot be presumed compatible. See the
  [complete ABI structure and serialization field order](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/include/sysio/chain/abi_def.hpp#L60-L154).
- Read the IDs emitted by the node and declared in the applicable ABI. Do not derive them
  from table text in this layer. The canonical current CDT computation hashes the eight
  big-endian bytes of raw table identifiers, chaining table/index raw identifiers for a
  secondary namespace. Some comments refer to string hashing, and the node has a separate
  string convenience overload. The overloads are not interchangeable. See
  [node executable helpers](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/include/sysio/chain/types.hpp#L85-L131) and
  [CDT executable helpers](https://github.com/Wire-Network/wire-cdt/blob/187d6a24ddc60c5c3f4238271815c124bcc80f11/libraries/sysiolib/contracts/sysio/kv_constants.hpp#L20-L71).
  That CDT revision is a source-inspection reference, not a selected build dependency.
  [The zero-ID collision regression](https://github.com/Wire-Network/wire-cdt/blob/187d6a24ddc60c5c3f4238271815c124bcc80f11/tests/toolchain/abigen-fail/table_id_zero_collision.cpp)
  confirms that zero is a real namespace value. Resolve secondary IDs through the ABI's
  `secondary_indexes` metadata, without treating them as the parent primary table ID.
- Node protobuf decoding expects an outer varuint32 byte length and an inner zpp_bits
  size-varint before the protobuf payload. It checks both lengths and preserves protobuf
  field names in JSON. A plain protobuf payload decoder is insufficient. See
  [initialization and JSON behavior](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/abi_serializer.cpp#L283-L339) and
  [double-length framing](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/abi_serializer.cpp#L342-L392).
- Real contracts already use the `slug_name` built-in: up to eight characters with the
  `[A-Z0-9_]` alphabet, a leading letter, and an empty zero sentinel. It uses an eight-byte
  packed value; canonical spellings occupy the low 48 bits. Noncanonical raw values can
  render the same text, so rendered key fields must not become physical identity. See
  [scalar representation and JSON limits](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/libfc/include/fc/slug_name.hpp#L29-L169),
  [the actual `sysio.chains` ABI](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/contracts/sysio.chains/sysio.chains.abi), and
  [key-codec tests](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/unittests/be_key_codec_tests.cpp).
- Known enum values decode to their declared names; unknown values remain numeric.
  [Node regressions](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/unittests/abi_tests.cpp#L3696-L3711)
  provide concrete value-codec expectations for a later slice.

## Fixture provenance and regeneration

[protocol-vectors.json](../fixtures/protocol-vectors.json) contains 314 synthetic/source-derived
vectors. No vector is a captured SHiP frame or an assertion that a contract was deployed.
The normalization strings are explicit expectations of the package-local contract; timestamp
goldens include manually specified epoch, one-day, and `uint32` boundary values. The generator
imports no Node/Rust implementation and performs no network or node operation.

The corpus covers positive timestamps, malformed scalar values, complete compound keys,
duplicate secondary values with distinct primary keys, row/index namespace separation, table
zero, maximum unsigned 64-bit code/payer, empty bytes, insert/delete identity equivalence,
retained deletion values, changed payer/ABI/block provenance, exact property sets, canonical
decimal/hex validation, and source numeric/ID validation. It also pins rejection of the explicit
shared leading/trailing whitespace set for ABI identifiers, including NEL and BOM. It contains
no non-JSON NaN/Infinity or lone-surrogate inputs; runtime-specific checks must cover those.

From the repository root:

```sh
python fixtures/generate-protocol-vectors.py
sha256sum -c fixtures/SHA256SUMS
```

The generator rewrites only the profile, corpus, and checksum file. Commit all three together
when changing their contract. Expected SHA-256 values are:

```text
5b214734d30aedd0a9945ecd315d2d62156d3126890aec2da26fcd1d5bc1db72  protocol-profile.json
53a2cc8b761216a89e127dbe841dcf6c5155ca54d94be5999e42c39b6da0cafe  fixtures/protocol-vectors.json
```

## Next independent evidence

Useful source contracts at the engineering node revision include
[`test_kv_map`](https://github.com/Wire-Network/wire-sysio/tree/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/unittests/test-contracts/test_kv_map)
for compound/signed primary keys,
[`test_kv_sec_query`](https://github.com/Wire-Network/wire-sysio/tree/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/unittests/test-contracts/test_kv_sec_query)
for secondary entries,
[`test_kv_wide_sec`](https://github.com/Wire-Network/wire-sysio/tree/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/unittests/test-contracts/test_kv_wide_sec)
for signed/compound secondary keys,
[`proto_abi_test`](https://github.com/Wire-Network/wire-sysio/tree/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/unittests/test-contracts/proto_abi_test)
for protobuf actions/results, and real
[`sysio.token`](https://github.com/Wire-Network/wire-sysio/tree/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/contracts/sysio.token),
[`sysio.chains`](https://github.com/Wire-Network/wire-sysio/tree/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/contracts/sysio.chains), and
[`sysio.roa`](https://github.com/Wire-Network/wire-sysio/tree/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/contracts/sysio.roa)
for scoped tables, slug keys, enums, and secondary indexes.

Committed WASM/ABI files are available for those fixtures, but their presence alongside C++
does not prove that they were rebuilt from that C++ with a particular CDT. Future capture must
record exact source/toolchain inputs, artifact SHA-256 digests, node build, genesis identity,
action/deployment sequence, raw handshake/frames, ABI deployments, and independent expected
results. Live/bulk equivalence and fork/reconnect recovery need their own acceptance evidence.
