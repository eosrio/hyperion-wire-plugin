# Constructed delta normalization measurement

This local measurement compares Wire69 `69a66064c077a405341f5aaf15e84b88b8d86ccb` with code commit `378830c172067fa2f971874137318d492b2d24fc`. The record is [`wire31-constructed-delta-benchmark.json`](wire31-constructed-delta-benchmark.json). The benchmark script is `scripts/bench-normalize-delta.mjs` and its exact Git-LF SHA-256 is `dac6e45b5e28d0d8950de5100905fa2c07cf4a4902b0d2a91d7c7a93d4b51137`.

Build both commits with their committed npm lockfile, copy the same script into each, and run from each repository root with `node scripts/bench-normalize-delta.mjs` (or the identical copied script). The test uses the actual provider and codec, captured SHiP handshake, and 64 constructed KV rows and secondary indexes sharing one selected ABI. It warms up 1,000 rows, then times 10,000 normalizations and hashes all results. Five independent processes per version and Node major were interleaved. Timing includes JSON result hashing. The fixed output digest was `97a1fdbfa8bf047d70ba49dcfa65024982ab350d5a30d86430cca035fcfbf9cb` in every run.

| Runtime | Baseline median | Candidate median | Median elapsed reduction |
| --- | ---: | ---: | ---: |
| Node 24.19.0 | 518.65 ms | 442.18 ms | 14.7% |
| Node 26.4.0 | 481.01 ms | 402.67 ms | 16.3% |

These are Windows local, constructed-corpus component measurements. They do not establish H3 throughput, memory use under production ABI churn, end-to-end performance, or Wire qualification. The cache holds at most eight entries for exact canonical ABI bytes of at most 64 KiB and the exact revision profile; larger ABIs use the uncached path. It caches only immutable ABI-derived parsing and codec artifacts. Each row still validates physical bytes and selected ABI bytes and re-evaluates deployment interval, account, chain and source identity. It does not cache ABI authority, ownership or canonicality proofs.
