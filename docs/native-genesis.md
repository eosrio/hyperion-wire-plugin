# Native genesis source verification

The optional synchronous `verifyNativeGenesis(input, source)` provider hook implements the
bounded Node source-semantic portion of [Wire #13](https://github.com/eosrio/hyperion-wire-plugin/issues/13)
for [History API #240](https://github.com/eosrio/hyperion-history-api/issues/240).
It consumes the SDK `ProtocolNativeGenesisInput` and returns `ProtocolNativeGenesisFacts`.

The selected source must be `wire-sysio-6508c9e8-engineering-v1`, upstream
`6508c9e8f4044df8d5acb082a7af3be6a80cd9a0`. The hook has no I/O and checks the exact source
schema, decoded native header and independently computed header ID, all nine physical streams
and 23 present rows, native ABI bytes, empty ABI barriers, native authorities, global configuration,
WASM defaults and complete resource values/billing. It uses existing strict codecs and preserves
the original resource-index count defect. Its bounds are 64KiB schema text, 1KiB block and 64KiB
deltas before decoding, followed by existing codec limits and exact inventory checks.

The original trace section must be null and source height must be1. Original SHiP predecessor
null remains unchanged; the returned zero predecessor comes from the actual header. Facts contain
only the three block-end native ABI states with original row ordinals and verified empty application
state. They contain no synthetic trace bytes, transaction, setabi anchor or receipt. A failure yields
no partial facts. Returned objects/arrays are detached and frozen.

Timestamp, valid chain configuration and producer key are not fixed to one network. K1/R1/EM/ED
public keys use source-verified inline billing. WA/BLS **native-genesis billing is unsupported** in
this first implementation and throws `unsupported_feature`; their ordinary crypto codecs are
unchanged. 7d genesis is also unsupported. Adding another family/profile requires source-semantic
billing/inventory evidence and qualification, rather than accepting arbitrary RAM values.

The host must select and verify source/profile/component identities and rerun the hook from its
immutable retained schema/block/delta sections before granting source authority. Provider assertions
or serialized facts alone are insufficient. Ordinary observations, including later-height missing
traces, keep their existing guards. Canonical frontier initialization, durable replay/fork/generation
fencing, source acknowledgment, projection readiness and API serving remain host responsibilities.
The portable projection still starts at checkpoint0 and requires actual block1 then contiguous2+.

No external operator genesis seed or head ABI is used. This check inherits the selected-reader
trust of ordinary ingestion. Full genesis-digest recomputation is not claimed: the v0 sections do
not include the initial finalizer key. Node/Rust coordinated genesis support, full workers/API,
future deployment input, fork/reconnect and release qualification remain open.

## Sources and evidence

- [Actual immutable capture](../fixtures/codec/native-genesis-6508-20261020/README.md), with audited
  ABI expectations and original input/result hashes.
- [Native database construction and billing](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/controller.cpp#L1829).
- [Fresh full delta emission](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/state_history/create_deltas.cpp#L48).
- [Header identity](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/block_header.cpp#L19),
  [literal schema](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/state_history/abi.cpp#L4),
  and [compiled native ABI](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/sysio_contract_abi_bin.cpp#L10).
- [Authority billing](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/include/sysio/chain/authority.hpp#L194),
  [initial resource defaults](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/include/sysio/chain/resource_limits_private.hpp#L254),
  [configuration checks](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/chain_config.cpp#L7)
  and [20MiB byte-array cap assertion](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/include/sysio/chain/config.hpp#L88).

`tests/native-genesis.test.mjs` exercises the public provider seam. Real captured expectations come
from the independent source/inventory audit, not the verifier. Constructed mutations and alternative
slot/key/configuration cases are explicitly labeled; they are not additional captured chains.
