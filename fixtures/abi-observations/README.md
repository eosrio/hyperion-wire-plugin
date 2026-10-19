# Synthetic ABI observation conformance vectors

These fixtures exercise the facts-only observation contract for
[History API #213](https://github.com/eosrio/hyperion-history-api/issues/213) and
[SDK #6](https://github.com/eosrio/hyperion-sdk/issues/6).

They are synthetic inputs with independently specified expected facts. They are not node captures,
canonical block proofs, ABI applicability proofs, snapshot qualification or Wire launch acceptance.
Some negative cases deliberately violate the source format. Positive observations describe what
the supplied source says; they do not establish that an arbitrary synthetic transaction was
accepted by a live chain.

## Format and use

The checked-in vectors.json has schemaVersion 1, a description, exact sourcePins and a vectors
array. Each vector includes:

- id and profileId, with the profile selecting its exact engineering source revision.
- source: chainId, blockId, previousBlockId and blockNum. A null predecessor explicitly records
  an unknown link.
- input.traces and input.accountRows. Omitted fields mean missing input; empty arrays mean
  genuinely empty source. A row retains ordinal, present, rawHex and its decoded value.
- Either expected, containing schemaVersion 1 and separate actionInputs, deployments and
  finalStates, or expectedError, containing an exact portable error code.

The Node host converts each row's rawHex into its raw Uint8Array without replacing missing
inputs with empty arrays. The Rust codec-driver operation observe_block_abi accepts
operation, profileId, source and input, retaining row rawHex in its JSON request. Driver responses
use result for observations or error for the portable code.

Expected uint64 global sequences are decimal strings, including values above JavaScript's exact
Number range. Input action ordinals identify source occurrences; expected facts explicitly follow
receipt execution order. Receipt ABI sequences are observations and never identify the action's
input epoch by themselves.

The corpus contains 109 cases per profile, 218 total. The two explicit 100001-item arrays exercise
collection limits before element interpretation. Reversed notification arrays exercise the
64-link accepted boundary and the 65-link rejected boundary before origin caching can hide depth.

## Manual oracle

generate.mjs uses the existing ABI/value codec only to construct binary ABI metadata, canonical
name bytes and physical account rows. It never imports or calls the Node or Rust observer.
Expected action origins, execution ordering, native effects, final-state records and error codes
are specified independently at fixture construction sites.

The same-width pair uses actual sysio::abi/1.3 metadata for action put with a single struct field:
A has old:uint32, B has new:uint32. Both consume 07000000 completely, producing old=7 and new=7
respectively. The source facts retain both deployments and their individual action anchors; the
final account row contains B. This fixture exposes why a successful decode under an older visible
ABI cannot establish correctness.

Every native ABI assignment remains a distinct observation, including identical bytes, an empty
ABI, malformed bytes and a structurally encoded unsupported ABI version. The oracle never parses
those bodies to decide whether the mutation occurred.

The self-setabi case deliberately reports the post-publication ABI sequence on the original
receipt. Its notification and notification-of-notification still reference the first receiver's
original input ordinal. A separate identical-content inline first receiver owns its own input.
Another case allocates actions 1,2,3 but executes them 1,3,2.

The native prefix cases retain trailing action bytes and accept noncanonical fc unsigned_int
lengths. In particular, the fifth length byte can retain its continuation flag and high bits:
the pinned native unpacker consumes at most five bytes and truncates the length to uint32.
An overlong zero length and fifth-byte overflow therefore remain valid empty-ABI observations.
The generic value codec's canonical varuint and full-consumption policy must not replace this
specific native interpretation.

## Coverage

Successful cases cover empty source with known/unknown predecessor, a snapshot-style block-end
account view, maximum receipt sequence values, the same-width ABI rename, allocation/execution
ordering, multiple native updates, clear/rejected final states, notification origins, identical
inline actions, onblock, an empty action name, an ordinary context-free action, presence flags,
row ordering, native prefix permissiveness and the depth boundary.

Source SHiP flags may arrive as JSON booleans or numeric 0/1. Positive cases exercise scheduled=0,
context_free=0 and context_free=1, including a mixed-carrier notification origin. Numeric 2 is
invalid for context_free, scheduled=1 remains unsupported, and a native setabi with context_free=1
remains unsupported. The SDK account-row present flag remains a strict boolean.

Failure cases cover missing/null inputs, malformed versus unsupported variants, statuses 1 through
4, scheduled/nested failed transactions, transaction/action exceptions and error codes, missing or
null receipts, receiver disagreement, zero/duplicate/Number/overflow/noncanonical global sequences,
ABI sequence range errors, duplicate transactions/ordinals, absent/cyclic/inverted creator links,
notification authorization/raw/name disagreement, missing action bytes/flags/authorization,
truncated native prefixes, context-free native setabi, raw-versus-decoded account disagreements
including creation_date, duplicate rows/accounts, ordinal ranges and source identity/block ranges.

This corpus does not establish durable persistence, canonical continuity, fork/restart recovery,
or readiness across parallel workers. Those remain host/coordinator qualification work. A
snapshot-style final-state observation cannot authorize earlier or intra-snapshot-block action
decoding. Retained Elasticsearch history does not need a full history reindex.

## Source basis

The exact engineering revisions are
[6508c9e8f4044df8d5acb082a7af3be6a80cd9a0](https://github.com/Wire-Network/wire-sysio/tree/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0)
and
[7dede884e0150d36fa788e85a119e10653ade8ca](https://github.com/Wire-Network/wire-sysio/tree/7dede884e0150d36fa788e85a119e10653ade8ca).
The relevant source paths were checked at both pins:

- [sysio_contract.cpp](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/sysio_contract.cpp#L213)
  assigns opaque ABI bytes and increments the target sequence for every committed setabi.
- [apply_context.cpp](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/apply_context.cpp#L98)
  runs native code before WASM and samples receipt metadata afterward; its execution loop runs
  notifications before queued inline actions.
- [transaction_context.cpp](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/transaction_context.cpp#L348)
  allocates all top-level actions before executing their inline children.
- [raw.hpp](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/libfc/include/fc/io/raw.hpp#L214)
  defines the permissive five-byte native unsigned_int prefix.
- [trace_converter.cpp](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/state_history/trace_converter.cpp#L7)
  serializes receipt-bearing accepted block transaction members and onblock.
- [serialization.hpp](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/state_history/include/sysio/state_history/serialization.hpp#L575)
  emits executed status and excludes scheduled/failed deferred traces for these Wire pins.

To regenerate after building the existing codec, run:

    node fixtures/abi-observations/generate.mjs

To check that the committed corpus matches the manual generator and exact LF bytes without
rewriting it, run:

    node fixtures/abi-observations/generate.mjs --check

Review changes to expected facts as source-semantic changes. Do not regenerate expectations by
recording the observer under test.
