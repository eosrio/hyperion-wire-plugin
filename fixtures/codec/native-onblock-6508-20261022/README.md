# Original Wire native onblock regressions

These six original SHiP frames are extracted without transformation from the
[retained block1–1480 source](https://github.com/eosrio/hyperion-history-api/tree/37035935facb306207194d8309d29542d68b8ad6/tests/fixtures/portable-state-worker).
The manifest records archive/member hashes, the exact 6508 engineering profile and testnet chain.
The handshake is reused byte-for-byte from the adjacent
[native-genesis capture](../native-genesis-6508-20261020/ship.abi.json).
Each selected native action includes its predecessor block so the header relationship is checked
against actual source, rather than a generated value.

| Block | Exact global sequence | Action bytes | Strict deployed-ABI failure |
| --- | --- | --- | --- |
| 33 | `41` | 116 | Trailing bytes at offset115 |
| 122 | `166` | 544 | Unknown crypto suite |
| 397 | `637` | 130 | Invalid optional marker |

All three select the actual block32 native ABI effect, action ordinal2, global sequence40,
ABI SHA-256 `f92dac127ba2a22bf2769f32f18486b149cfbb1db9ec249d3a6c88faba0ad06b`.
The Node22/24 receipts replay all1480 authenticated source frames through the production ABI
reducer in memory, preserving action-position selection. That is reducer/source evidence, not a
durable canonical certificate. All1479 actual `onblock` payloads round-trip as predecessor native
headers; the deployed contract mapping becomes incompatible after block32.

`official-clio-receipt.json` records offline conversions using the exact converter accompanying
the source-pinned testnet node. Binary hashes, process/start/listener ownership and chain identity
were checked before and after; no service, config or data file was changed. Native header values
and re-encoding match the original bytes. The same converter's legacy contract-ABI path exits0
but produces incorrect header fields for33/397 and an error without JSON for122; exit status alone
is therefore not an oracle. `official-clio-comparison.json` retains the semantic comparison.

`expected.json` preserves the action's `{header: ...}` wrapper. The only numeric representation
normalization is the official converter's safe uint64 threshold number6 at397 to decimal string`"6"`.
Every raw byte, receipt sequence, policy and optional field remains exact.
`native-header-parity-receipt.json` records native Node22/24/Rust codec operations and strict
append/truncate controls. The test suites additionally construct altered source/IDs, user and
inline lookalikes, notifications and compressed membership controls; those are not captured chain
events and are not substituted for these original frames.

The manifest and parent SHA256SUMS bind all retained fixture content. This is an original-source
regression corpus. Native source labels, durable canonical admission, host/API/cache/stream
integration, live workers and fork/release qualification remain separate gates.
