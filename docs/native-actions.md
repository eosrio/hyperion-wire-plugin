# Native action source verification

[Wire #15](https://github.com/eosrio/hyperion-wire-plugin/issues/15) adds a package-local
`createWireNativeActions(profile)` Node factory and equivalent Rust
`codec::native_actions::{observe_native_actions, decode_native_value, encode_native_value}`.
They implement the version-1 contract in
[SDK #19](https://github.com/eosrio/hyperion-sdk/issues/19) for the pinned
6508 source dialect. The SDK dependency is an exact development commit.
[Wire #19](https://github.com/eosrio/hyperion-wire-plugin/issues/19) adds the separately selected
`wire-sysio-6508c9e8-native-engineering-v1` profile. Its inert descriptor requires
`nativeActions: {interfaceVersion: 1}`, and `createProtocolProvider()` exposes the capability only
for this profile. The host must admit this requirement before importing executable code.
The existing `wire-sysio-6508c9e8-engineering-v1` and `wire-sysio-7dede884-engineering-v1` IDs
remain native-inactive through normal provider selection; default codec selection is unchanged.
The package-local native factory still accepts the original canonical 6508 profile for existing
fixtures. Both Node and Rust validate every canonical profile field for either supported 6508 ID.
This does not grant canonical authority or activate a running chain.

The controller's implicit `onblock` action packs the predecessor's native `block_header`.
The deployed `sysio` contract ABI at block32 describes a different, older header layout.
Strict contract decoding therefore remains an error; neither ABI selection nor trailing-byte
checks are relaxed. Native values retain the existing `{header: ...}` response shape, with exact
decimal strings for uint64 fields. The opaque native kind is `wire.sysio.onblock.v1`.

## Original source and detached decisions

Node observation accepts the exact retained handshake text, signed-block bytes and trace bytes,
plus the host's chain/block/predecessor position. Rust's JSON boundary uses `blockHex` and
`tracesHex` for those same bytes. The verifier has no I/O or account ABI lookup. It checks the
pinned handshake digest, current native header ID/height/predecessor, and the existing source
observer's complete first-receiver origin inventory. Notifications retain their verified input
origin; they do not receive independent native designations.

Only the first transaction's first root can be native. Verification requires the exact implicit
authorization/default partial-transaction fields, a single root, the original action bytes, the
predecessor header's recomputed ID and the reconstructed unsigned transaction's SHA-256 ID.
It also proves that this ID is absent from the complete packed user-transaction inventory.
Supported action-trace v0/v1 framing follows the pinned schema and existing source observer.
Same-name user transactions and inline actions remain contract decisions.

User membership supports uncompressed packing and bounded zlib decoding. Every transaction must
decode strictly and re-encode to its original bytes before hashing. Duplicate IDs, incomplete or
trailing compressed data, unknown compression and unsupported packing cannot establish absence.
The decompressed cap is 10 MiB per transaction, matching pinned native source; aggregate membership
is capped at 16 MiB. Schema text is at most 64 KiB, and each original binary section is at most 16 MiB;
existing codec item/depth/node bounds also apply. Compressed controls are constructed fixtures,
not a claim that the captured chain uses compressed block transactions.

Global source/framing failures throw and yield no fabricated observations. Candidate-only failures
yield an `incomplete` decision for that original first receiver, preserving unrelated `contract`
decisions. Stable codes are `native_source_invalid`, `native_source_unsupported` and
`native_source_limits`. Observations are detached labels, never canonical membership, durability,
decoding or readiness authority. The host must retain and rerun them from authenticated original
source, match raw digests and certified input origins, and revalidate canonical/fork authority.
Native facts must remain separate from ABI-state reduction so a failed native interpretation
cannot poison unrelated contract state.

## Evidence and remaining gates

The [original three-case fixture](../fixtures/codec/native-onblock-6508-20261022/README.md)
retains source blocks, the actual input ABI and pinned official-clio conversions. Native values
and exact byte round-trips are checked against that independent oracle. The original fixture's
profile ID, bytes and official converter receipts remain unchanged; the same corpus is explicitly
selected under both 6508 profiles. Node and Rust share
malformed-source, identity, user/inline/notification, packed-membership and resource-limit controls.
The fixture checker binds every retained member; package checks cover emitted declarations and
the native Rust ABI source as part of one coordinated source bundle.

This foundation does not certify durable native admission, persisted schema-v2 action metadata,
API/cache/stream reconstruction, live workers, forks or release compatibility. A native-required
profile requires compatible host admission and separate worker qualification before operator
activation. The new profile preserves the original genesis verifier's absent traces and ABI facts.
Existing strict contract ABI and native-genesis behavior is preserved. No rs_abieos defect or
new rs_abieos release is implied by this Wire-specific source mismatch.

Primary source at `6508c9e8f4044df8d5acb082a7af3be6a80cd9a0`:

- [Implicit defaults](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/controller.cpp#L955),
  [ordering](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/controller.cpp#L2258),
  and [native header packing](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/controller.cpp#L3502).
- [Native header fields](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/include/sysio/chain/block_header.hpp)
  and [deployed contract ABI](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/contracts/sysio.system/sysio.system.abi).
- [Transaction ID](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/transaction.cpp#L32),
  [exhaustion and decompression cap](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/transaction.cpp#L234),
  and [native block ID](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/block_header.cpp#L19).
