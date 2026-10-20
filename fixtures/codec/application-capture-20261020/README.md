# Captured Wire application workload

These engineering inputs were produced on 2026-10-20 by an isolated official Wire v1.0.0
node at revision `7dede884e0150d36fa788e85a119e10653ade8ca`, selected as
`wire-sysio-7dede884-engineering-v1`. They extend [Wire #2](https://github.com/eosrio/hyperion-wire-plugin/issues/2)
with actual contract execution. Final testnet pins remain pending.

The node and clio executable SHA-256 values are respectively
`ad275fff367f903b0a4a2a8d402f1d52e4a709ae9a4d362654b5315617db189e` and
`a8298cc96d0265b384aebba178d255ff73917fcae0a0d4abf086f45016efb76a`.
Chain ID: `9f70136446c1a3ea95deefbbe4aaeee4f31f16870eba976fcb7054172fbffacf`.
Public genesis SHA-256: `af50077d52d2acc33ca30ce63e1cf2f938275fa96093e2412ccc562db3123d4c`.
The original schema SHA-256 is `94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9`.

## Retained inputs

[manifest.json](manifest.json) binds two original archives and their inner inventories:

- `raw-capture.tar.gz`: 3,754 regular files / 12,897,392 bytes, including the public export
  index. Its 3,753 indexed payloads / 12,148,075 bytes retain public genesis/process pins,
  committed ABI/WASM Git identities, signed operation receipts and irreversible canonical
  blocks, original WebSocket frames, SHiP schema/status/requests/ACKs, all raw result and
  nested payloads, and original official-clio arguments/stdout/stderr.
- `official-row-oracles.tar.gz`: 1,372 regular files / 1,372,136 bytes. Its 342 deduplicated
  offline official-clio commands independently observe all 627 physical rows and eight
  native ABI deployment occurrences. Original inputs, output, errors, capture code and hashes
  remain intact. Private producer values are excluded from both archives.

Seven account creations, fourteen deployment operations and fifteen application operations
were confirmed in irreversible canonical blocks before the final capture. The deployed ABI/WASM
blobs are exact committed artifacts from that Wire revision, rather than local CDT rebuilds.
The capture uses [the bounded range driver](../../../scripts/capture-wire-range.py), SHA-256
`b40f65d1d64e97dc236eb52e6e143feb0571c5f06a632f89f82f1935afe13e23`.
Nothing in the replay check starts a node, sends transactions, contacts a service or reads keys.

## Observed coverage

| Input | Observed result |
| --- | --- |
| Source interval | 119 contiguous irreversible blocks, 2–120 inclusive; 155 transactions and 160 action receipts. |
| Physical state | 627 rows: account157, resource_limits155, resource_usage155, resource_limits_state119, permission14, account_metadata8, code4, contract_row_kv13, contract_index_kv2. |
| Primary KV | Eleven observed inserts, one update and one deletion; compound region/ID keys, signed key values, exact uint64 max ID and amount `9007199254740993`. |
| Secondary KV | Two distinct insertions sharing a secondary key with different complete primary keys; no observed secondary update/deletion. |
| ABI deployments | Seven initial native setabi occurrences plus wireupgrade's replacement at117; old action111 uses ABI sequence1, new action120 uses sequence2. |
| Action origins | Block108 has two roots, two notifications and two byte-identical empty inline inputs with distinct origins. Allocation and receipt order differ. |
| Protobuf | Actual actions at102/105 and a return at102 with `value:42` and `str_value:"result_string"`. |

All 119 delta messages have Wire's source-pinned resource-index count defect. Official clio's
original vector omits the last physical `resource_limits_state` stream in every block.
The independent cursor consumes every original byte and checks the exact permitted count/order
correction. The generic decoder must reject these uncorrected messages; the transport-specific
decoder must report the declared/actual counts and preserve the complete rows.

The independent [audit.py](audit.py) generates 1,267 existing-driver operations from verified
source bytes. It imports no implementation codec. It joins plans, packed transaction hashes,
canonical block IDs, original trace receipts, ABI deployments and physical rows. Checks include
the exact binary metadata and lossless ABI reencode, rather than assuming committed JSON must
reproduce the original binary. Present-empty trailing sections and the original protobuf string
remain distinct from JSON ABI normalization.

The generator initially labels 455 row checks `parity-only`; the CI checker requires and verifies
their supplementary typed official-clio observations. Those checks cannot pass on Node/Rust
agreement alone. Oracle comparison preserves unsafe JSON integer tokens exactly before
ABI-directed decimal-string normalization. Original raw oracle files are never rewritten.

## Reproduction and scope

After the normal build and pinned toolchain setup, run `npm run test:cross`, or run
`node scripts/check-application-capture.mjs` from the repository root. The checker verifies both
archives and exact ordinary-file inventories before extraction, uses an owned temporary
directory, regenerates the audit and compares Node/Rust results with independent expectations.
It requires no services or network access.

[summary.json](summary.json) records the original local comparison receipts and generated hashes.
The replay proves this captured 7d codec workload. Starting ancestry and the pre-range ABI
frontier remain unknown. Full-width positive cases here are application values; actual sequence
counters are small. No 6508 node capture, same-block ABI replacement/clear, malformed deployment,
secondary update/deletion, failed/deferred transaction, fork recovery, full-worker/sink/PIT,
throughput, Bun runtime or selected-testnet acceptance follows from this corpus.
