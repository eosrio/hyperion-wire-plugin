# Wire codec development contract

These package-local interfaces implement the source-pinned engineering boundary for
[Wire #2](https://github.com/eosrio/hyperion-wire-plugin/issues/2). They are not a released SDK
provider, a production runtime activation or a testnet qualification claim.

## Profiles and metadata

`resolveCodecProfile()` selects `wire-sysio-6508c9e8-engineering-v1` by default. Select
`wire-sysio-7dede884-engineering-v1` for the captured official v1.0.0 node. Each profile binds
an exact source revision, the 2025 epoch/500 ms slot interval and whether `slug_name` is a
builtin string or an ABI-declared struct. Never infer this from a table or value spelling.
Final launch pins remain pending.

`wire-sysio-6508c9e8-native-engineering-v1` uses the same complete 6508 codec parameters while
requiring explicit native action interface 1 admission through the provider descriptor. This new
engineering profile preserves the original default and both existing IDs. It is not a launch pin.

Node exports `decodeWireAbi`, `encodeWireAbi` and `createWireValueCodec`. Rust exposes the
equivalent `codec::{decode_abi, encode_abi, decode_value, encode_value}` functions with an
explicit `CodecProfile`. Inputs/outputs are bytes and JSON values. Both components retain
Wire's string table/index names, authoritative uint16 IDs (including zero), secondary metadata,
variants, action results, enum definitions, ABI extensions and protobuf descriptors.

Binary `protobuf_types` stays its original JSON **string**, preserving whitespace and key order
for metadata round trips. JSON ABI input may supply the descriptor object, which is serialized
with UTF-8 key sorting on encoding, so both components produce the same descriptor object
carrier. Absent trailing metadata sections stay absent; unknown metadata fields or extra
binary tail bytes fail with `unsupported_feature` rather than disappear through a legacy ABI.
The known layouts are `sysio::abi/1.0` through `1.3`. New layouts need a reviewed capability update.

## Value boundary

The codecs walk aliases, struct inheritance, variable/fixed arrays, optionals, trailing binary
extensions, variants and Wire enums. Builtins take precedence over reflected builtin structs,
as required for existing slug ABIs on the newer node. Known enum values render their declared
names; unknown values retain their numeric value. Encoding accepts declared labels or an
unambiguous suffix after the last underscore. Wide 64/128-bit integers always use decimal
strings at the shared JSON boundary; smaller integers are numbers. ABI `bool` follows the
upstream uint8 carrier and is not coerced to a JavaScript boolean on decoding.

Bytes/checksums and float128 retain hexadecimal carriers. Float32/64 follow node JSON with
17-place fixed decimal strings, `inf`, `-inf` and `nan`. Assets, symbols, names, bitsets, time
values, all six public-key/signature families (K1/R1/WA/EM/ED/BLS), and nested Wire block
timestamps use their source layouts. Crypto conversion checks framing and carrier checksums;
it does not authenticate signatures or validate BLS proofs.
WebAuthn's variable crypto payloads are limited to 4 KiB and crypto input text to 8,200
characters before base58 conversion, bounding that conversion's CPU cost separately.

Protobuf uses the ABI's FileDescriptorSet and preserves declared node field names and Google
JSON conventions. The outer size covers the inner varuint32 size plus message bytes. Both
lengths are checked before decoding. Required unsupported features fail explicitly. Deprecated
protobuf groups are outside this supported value boundary; descriptors remain retained.

Timestamp decoding reproduces node JSON, including negative `time_point` duration strings.
Encoding `time_point` accepts canonical positive UTC ISO values with exactly three fractional
digits and no zone suffix. The source parser mishandles longer fractions and cannot parse its
own negative duration output; this API rejects those inputs. Keep the original value bytes for
lossless replay: node JSON also truncates positive microseconds to milliseconds.

Collections are bounded to 100,000 elements, values/frames to 16 MiB, nesting to 64 and
traversal to one million nodes. Recursive/fixed-array and descriptor-driven protobuf work must
check limits before allocating unbounded output. Noncanonical varuint32, malformed UTF-8,
truncation and unexpected trailing bytes are rejected. Optional presence markers are 0/1.
Failures expose `invalid_abi`, `invalid_value`, `unsupported_feature` or `limits_exceeded`.

## SHiP and KV context

`createWireShipCodec(handshake, profile)` uses the advertised ABI to encode/decode requests,
ACKs and results, and decode signed blocks, traces, deltas and their rows. `decodeBundle`
returns the original frame, envelope and nested data; row data retains its exact raw bytes.
`normalizeKvRow` converts a decoded primary/secondary stream to the lossless physical identity
without using display names as identity. It retains payer, presence, both complete secondary
and primary keys, uint16 IDs and the caller's block/ordinal/deployment context.

`createWireDeploymentRegistry` snapshots a host-supplied ABI view. Selection must match chain,
raw contract identity, an inclusive start/exclusive end position and the supplied deployment ID.
Ordinals distinguish ABI changes within a block. Missing or overlapping deployments, missing
numeric table mappings and ambiguous primary/secondary IDs fail. There is no head ABI fallback.
The runtime proves canonicality and replaces snapshots after forks; the codec does not prove it.
Primary values are decoded only for present rows; removed rows retain their original context.
Ordered KV key encoding stays opaque, so value ABI decoding never corrupts physical key identity.

### Evidenced upstream delta count defect

Both investigated revisions count `resource_index` once in `pack_deltas` but emit that index as
both `resource_limits` and `resource_usage`. The captured block declares three streams and
contains four. Official clio decodes three and silently leaves the final 109 bytes unread.
The generic `table_delta[]` decoder rejects that frame.

`decodeWireShipDeltas` / Rust `codec::ship::decode_deltas` provide a separate compatibility path
for these exact source profiles. It permits precisely one extra stream, requires the two
resource streams and unique upstream stream ordering, and fully consumes the corrected view.
It reports `framing:{declaredCount,actualCount,compatibility:'wire-resource-index-count-v1'}`.
`decodeBundle` retains the original frame and reports this framing record. Arbitrary trailing
bytes, unknown stream ordering and unselected profiles are rejected. This workaround does not
change the node or fix its historical log; an upstream node fix still needs qualification.

Source: [pinned pack_deltas](https://github.com/Wire-Network/wire-sysio/blob/7dede884e0150d36fa788e85a119e10653ade8ca/libraries/state_history/create_deltas.cpp).

## Executable fixtures and remaining integration

`scripts/codec-driver.mjs` and Rust `cargo run --locked --example codec-driver` accept a JSON
array from stdin or a filename. Operations are `decodeAbi`, `encodeAbi`, `decodeValue`,
`encodeValue` and `decodeDeltas`, with `profileId`, inline `abi`, `typeName`, `hex` or `value`
as applicable. Results are arrays of `{result:...}` or `{error:<code>}`. The driver is usable
by host integration without a socket or database. `npm run test:cross` compares both
implementations with independent fixtures and malformed-input mutations.

[Provenance](codec-provenance.md) separates committed upstream ABI/WASM hashes, regenerated
binary ABI conversions, the release-node capture and newer source-derived slug/chain/KV values.
The original single-block corpus had no deployed application contracts. The later
[captured application workload](../fixtures/codec/application-capture-20261020/README.md)
adds actual primary/secondary KV records, protobuf actions/return values, repeated inline
origins and native ABI deployments. Its 1,267 operations are checked across Node/Rust with
independent raw-byte and official-clio expectations. Unknown starting ABI state, unobserved
secondary deletion, worker/provider integration (#212/#41), forks/recovery and the unified
operator distribution (#3) remain distinct gates. Preserve existing Elasticsearch history
throughout those integrations.
