# Wire codec fixture provenance

These are engineering fixtures for issue [#2](https://github.com/eosrio/hyperion-wire-plugin/issues/2).
They do not select the final testnet launch profile or qualify live indexing, forks, recovery,
backend behavior, or the unified operator distribution.

Two source revisions are kept separate:

- `6508c9e8f4044df8d5acb082a7af3be6a80cd9a0`: investigated source profile,
  `wire-sysio-6508c9e8-engineering-v1`.
- `7dede884e0150d36fa788e85a119e10653ade8ca`: official `v1.0.0` binary and source,
  `wire-sysio-7dede884-engineering-v1`.

## Exact committed artifacts

[The artifact manifest](../fixtures/codec/artifacts/manifest.json) records the source path,
Git blob ID, SHA-256 and byte length of all 28 ABI/WASM blobs: `test_kv_map`,
`test_kv_sec_query`, `proto_abi_test`, `sysio.token`, `sysio.chains`, `sysio.opreg` and
`sysio.roa` at both revisions. Fourteen ABI files are retained byte for byte under
`fixtures/codec/artifacts/`. WASM binaries are digest records of the exact upstream committed
blobs, not rebuilt artifacts; this work neither rebuilt nor deployed these contracts.

Every blob can be independently recovered with `git show <sourceRevision>:<sourcePath>`.
The manifest's `retainedPath: null` for WASM is intentional. No build/compiler provenance
is invented for committed binaries.

## Official binary serialization oracle

[The raw capture](../fixtures/codec/oracle-capture.json) retains every offline `clio convert`
argument, stdout, stderr and exit code. [The vectors](../fixtures/codec/oracle-vectors.json)
contain only successful conversions. The fixture producer was official Wire `clio v1.0.0`,
source revision `7dede884e0150d36fa788e85a119e10653ade8ca`, binary SHA-256
`a8298cc96d0265b384aebba178d255ff73917fcae0a0d4abf086f45016efb76a`.
It runs on the existing isolated Hyperion-1 fixture host and never accesses keys or wallets.

`pack_hex --type abi_def` uses the official native `fc::raw::pack(abi_def)` fallback.
The ABI oracle's binary bytes are regenerated from the retained committed JSON ABI.
They are not claimed to be previously deployed binary ABIs. Native ABI unpacking is invoked
without `--type`, and its output is required to have the expected ABI version/structure;
`unpack_hex --type abi_def` lacks the corresponding native fallback in this clio revision.

Custom ABI values use explicit `--abi-file` and `--type`; all execution is offline. Primitive
values, compound contract values, enum names and numeric fallback, protobuf action/result values,
fixed-width varint aliases, assets, time, floating point, public-key/signature rendering and
release slug structs are exercised. The canonical codec boundary renders 64/128-bit integers
as decimal strings; official clio's JSON sometimes emits smaller integer values as JSON numbers.
Comparison must normalize those fields by ABI type without altering the retained raw oracle.

`clio` can catch serialization errors and exit zero with an empty stdout and an `ERROR` stderr.
The capture tool rejects that result. The raw capture explicitly preserves excluded conversions.
In particular, the release binary cannot load the newer 6508 chain/opreg ABIs because that
binary lacks the `slug_name` builtin. Those exclusions are not successful codec acceptance.

Regeneration from an explicitly authorized fixture host:

```sh
node scripts/capture-wire-codec.mjs --host root@HOST
```

The generator imports no implementation under test and writes only its owned fixture directory
on the remote fixture host. It validates input ABI digests before copying those public files.

## Source-derived newer slug behavior

The release ABI represents `slug_name` as `{value:uint64}` and the release serializer lacks
a `slug_name` builtin. The newer source uses a builtin string carrier, even when an ABI also
contains a legacy struct with that name. These are distinct supported profile semantics.
The newer source behavior is supported by
[the pinned slug header](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/libfc/include/fc/slug_name.hpp)
and [the builtin registration](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/abi_serializer.cpp).

[The source-derived vectors](../fixtures/codec/source-vectors.json) are independently packed
with Python `struct` and the documented six-bit alphabet. Their producer is explicitly
`source-derived-independent-python`; they are not a 6508 node-built or clio oracle.
Regenerate them with `python fixtures/codec/generate-source-vectors.py`.

## Captured SHiP traffic

[The SHiP capture](../fixtures/codec/ship-capture.json) was read from the already running,
loopback-only isolated `v1.0.0` node, with chain ID
`0b99f90492dab673bcf7e2c9ed1cabab6019de897a90996f00d9717b84ed89d2`.
It includes the actual handshake ABI, status request/result, one irreversible block request/result,
and an ACK. The block is `6350`; the captured signed block, transaction traces and table deltas
were separately decoded by the same official clio binary using the captured handshake ABI.
The exact handshake SHA-256 is
`94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9`.

[Eight SHiP vectors](../fixtures/codec/ship-vectors.json) preserve both complete source bytes
and independent expected JSON. The capture reads one block, bounds messages to 16 MiB and
sockets to 20 seconds, and changes no node/contract configuration. It contains a transaction
trace and four physical delta streams: `account`, `resource_limits`, `resource_usage` and
`resource_limits_state`. The upstream count declares only three; clio's retained JSON silently
omits the final stream. The generic codec rejects this trailing data. The separate, source-pinned
transport decoder fully consumes it and reports the correction, as described in
[the codec contract](codecs.md#evidenced-upstream-delta-count-defect). It does not
contain deployed application KV traffic; synthetic KV fixtures and later deployed workloads
must be labeled separately. The driver is
[the standard-library capture script](../fixtures/codec/capture-ship.py).

These operations did not restart the node, deploy contracts, or use private material.
The initial capture attempt rejected a fragmented handshake before any block request; the
final driver handles standard WebSocket continuation frames and retains the successful capture.

[Additional source-derived vectors](../fixtures/codec/extra-vectors.json) retain full 64-byte
primary/secondary keys at numeric IDs 0 and 65535, a newer `sysio.chains` row with nested slug
and known/unknown enum values, and negative time-point rendering. Their Python generator uses
literal source layouts and imports no implementation under test. They are not deployed KV
captures. The boundary corpus separately records strict validation regressions.

[The crypto capture](../fixtures/codec/crypto-capture.json) adds official clio conversions for
all six generic public-key/signature families. Its genuine BLS key comes from the hash-verified
public genesis; its BLS signature comes from the captured block's QC. Generic BLS crypto values
reflect a shared-pointer presence byte followed by fixed bytes. They do not use the standalone
BLS class's length prefix. The rejected initial frame attempts remain recorded separately from
the successful goldens; both implementations check the successful independent bytes.

## Deployed application workload

The [2026-10-20 application corpus](../fixtures/codec/application-capture-20261020/README.md)
retains 119 original irreversible blocks from a separate isolated 7d engineering chain, with
36 submitted account/deployment/application transactions. Its archives preserve public
genesis/process/source pins, exact committed ABI/WASM blobs, signed transaction receipts,
original transport bytes and nested payloads. An independent cursor verifies full membership,
all physical streams and native ABI epochs before generating 1,267 existing-driver operations.

An additional 342 offline official-clio commands independently observe all 627 physical rows
and eight native ABI deployment occurrences. Original stdout/stderr and input hashes remain
retained; the checker preserves unsafe JSON integer tokens before ABI-directed normalization.
Binary ABI round trips use independently parsed original metadata, including present-empty
tail sections and the original protobuf descriptor string. Semantic JSON comparison does not
require differently ordered descriptor objects to reproduce the original binary text.

The executable comparison checks both Node and Rust. This later workload supplies actual
KV/application evidence for its selected engineering profile; it does not close the initial
ABI-frontier, unobserved secondary-delete, full-worker, fork/recovery or final-testnet gates.

## Node JSON observations

Official clio renders ABI `bool` as numeric 0/1; `time_point` and block timestamps with
millisecond precision; `time_point_sec` without a fractional suffix; and finite `float32`/
`float64` as strings with 17 fractional digits. Floating special values render as `nan`, `inf`
and `-inf`. Protobuf JSON preserves the declared snake_case names, and its encoded message has
both an outer and an inner varuint32 length. The source validates both lengths exactly.

The raw oracle includes the release date parser's surprising handling of a six-digit input
fraction. Expected decoding is bound to its captured binary bytes, not to an assumption that
that input round-tripped unchanged. This is an observed serializer behavior, not a change to
Hyperion or a recommendation to reproduce the parser on new inputs.

All public fixture files are hash-bound by [SHA256SUMS](../fixtures/codec/SHA256SUMS).
