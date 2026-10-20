# Wire ABI source observations

This is the source-facts slice of [Wire #8](https://github.com/eosrio/hyperion-wire-plugin/issues/8)
and [History API #213](https://github.com/eosrio/hyperion-history-api/issues/213), using the additive
[SDK #6 contract](https://github.com/eosrio/hyperion-sdk/issues/6). It does not select an applicable
contract ABI or authorize action decoding.

The provider's optional `observeBlockAbi(input, source)` hook consumes the complete decoded SHiP
traces and raw/decoded account rows before history filters, root-only selection, truncation or
numeric conversion. It returns separate `actionInputs`, `deployments` and `finalStates` lists.
Missing required input or unsupported semantics throws; a capturing host retains raw source and
records incomplete extraction. Empty lists are successful observations only for genuinely empty
inputs. Cleared, malformed, unsupported and identical-byte ABI deployments remain raw facts;
the observer does not parse their contract schemas.

## Pinned execution semantics

The supported engineering profiles identify node revisions
`6508c9e8f4044df8d5acb082a7af3be6a80cd9a0` and
`7dede884e0150d36fa788e85a119e10653ade8ca`. They remain engineering pins, with no selected launch
node/contracts/genesis or live-testnet qualification implied.

- `actionOrdinal` is an allocated occurrence identity, not execution order. Pinned execution can
  allocate roots 1 and 2, then execute root 1, its inline action 3, and root 2. Facts retain those
  ordinals but sort by lossless decimal uint64 receipt `globalSequence`.
- Native `sysio::setabi` writes its payload's target account ABI before the action's WASM and
  receipt. Self-setabi therefore has a pre-mutation input and can have a post-mutation receipt ABI
  sequence. `receiptAbiSequence` is evidence, not an input-epoch identifier.
- Notifications copy the original action input. The observer validates creator ancestry and
  identical account/name/authorization/raw data, and links them to the first receiver's input
  ordinal. Notification copies do not repeat native deployment effects. An inline first receiver
  owns a fresh input even if its bytes equal an earlier action.
- Both pinned nodes export accepted receipt-bearing transactions, including onblock, as status 0;
  scheduled/deferred failure semantics are not enabled. The hook rejects other statuses,
  speculative/failed traces, missing receipts and inconsistent ancestry. Numeric SHiP bool
  carriers 0/1 are normalized alongside JSON booleans; other values are rejected.
- Final account deltas contain block-end ABI bytes, without ABI sequence. Multiple native
  deployments can collapse into one final row. A final row cannot identify an earlier action's ABI.

Primary sources: [execution and receipts](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/apply_context.cpp#L94-L179),
[notification/inline scheduling](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/apply_context.cpp#L253-L275),
[top-level allocation](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/transaction_context.cpp#L348-L394),
[native ABI assignment](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/chain/sysio_contract.cpp#L213-L243),
[accepted trace selection](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/state_history/trace_converter.cpp#L7-L31)
and [serialized transaction semantics](https://github.com/Wire-Network/wire-sysio/blob/6508c9e8f4044df8d5acb082a7af3be6a80cd9a0/libraries/state_history/include/sysio/state_history/serialization.hpp#L574-L610).
The [fixture provenance](../fixtures/abi-observations/README.md) links both source revisions.

## Native prefix parsing

The pinned native `fc::raw::unpack` reads a setabi account/vector prefix without requiring full
action-byte consumption. Its native unsigned-int length accepts overlong encodings, consumes at
most five bytes and keeps the low 32 bits. The observer mirrors this behavior only for the native
mutation payload and retains the complete original action bytes. It does not weaken the generic
ABI/value codec's canonical length or trailing-byte checks.

An empty binary name is also retained when supplied by the source; ordinary action names are
not required to be nonempty. Unknown variants, malformed prefixes and inconsistent raw/decoded
account rows fail extraction. Account rows are checked against their complete binary layout,
including the timestamp field.

## Node and Rust consumption

Node callers use the selected SDK provider and typed `Uint8Array` account-row bytes. Rust exposes
`codec::observations::observe_block_abi`; the existing codec drivers share operation
`observe_block_abi` with `{profileId, source, input}`. The JSON adapter represents row bytes as
`rawHex`; both return the same portable SDK facts. No database calls or native ABI objects cross
this interface.

Both implementations bound collections to 100,000 items, aggregate UTF-8 text to 16 MiB, traversal
to 1,000,000 nodes/depth 64, and notification ancestry to 64 links. The Node typed raw-byte fields
are budgeted as the equivalent JSON hexadecimal carrier. Exceeding a package limit produces an
explicit extraction failure rather than truncating observations.

`npm test` exercises both manual vectors and selected production SHiP sessions. `npm run test:cross`
compares the independent expected facts/errors with both implementations. The fixture generator
uses existing codecs only for transport construction, never observer output as its oracle.
The packed consumer also exercises the optional hook from installed artifacts. The existing
captured block 6350 supplies an onblock/account-row path; it contains no user contract deployment.

## Remaining applicability gates

The capturing host must bind these facts to retained source bytes, verified component/profile
pins and a durable journal. A later runtime coordinator must establish contiguous canonical
coverage, initialize qualified genesis/snapshot seeds, reconcile observations with final account
state, propagate fork generations, and issue verified action/KV bindings before decoding.

ABI bytes and global sequences roll back with chain DB state, so receipt sequences can recur on
another fork. The enclosing source block identity remains mandatory. A post-block snapshot seeds
only state after that block; it cannot establish earlier or intra-snapshot-block action inputs.
SHiP result metadata does not itself attest complete snapshot coverage. Genesis can install the
built-in system ABI without an observed setabi, requiring a separately verified seed.

This implementation leaves the existing unavailable/raw fallback guards in place. It does not
complete fork/restart recovery, historical Wire tools, bare-metal profiling, coordinated native
distribution or selected-testnet acceptance. Existing Elasticsearch history stays usable while
the new ABI coverage projection initializes separately; no full history reindex is required.
