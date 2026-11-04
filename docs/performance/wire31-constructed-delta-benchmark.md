# Constructed delta normalization measurement

This local measurement compares Wire69 `69a66064c077a405341f5aaf15e84b88b8d86ccb` with code commit `378830c172067fa2f971874137318d492b2d24fc`. The record is [`wire31-constructed-delta-benchmark.json`](wire31-constructed-delta-benchmark.json). The original measurement used a root-copied script with SHA-256 `dac6e45b5e28d0d8950de5100905fa2c07cf4a4902b0d2a91d7c7a93d4b51137`. Its imports were corrected for the checked-in path; the checked-in `scripts/bench-normalize-delta.mjs` has SHA-256 `e70f33773ba4d7edd6acbeb0f3e2c21a0439abab5f8753599fb06d7cda97324c`. The original record is unchanged.

For the original record, the identical original script was copied to each repository root and run there. For the corrected runner record below, build both commits with their committed npm lockfile, copy the checked-in script into `scripts/` of each checkout, and run from each repository root with `node scripts/bench-normalize-delta.mjs`. The test uses the actual provider and codec, captured SHiP handshake, and 64 constructed KV rows and secondary indexes sharing one selected ABI. It warms up 1,000 rows, then times 10,000 normalizations and hashes all results. Five independent processes per version and Node major were interleaved. Timing includes JSON result hashing. The fixed output digest was `97a1fdbfa8bf047d70ba49dcfa65024982ab350d5a30d86430cca035fcfbf9cb` in every run.

| Runtime | Baseline median | Candidate median | Median elapsed reduction |
| --- | ---: | ---: | ---: |
| Node 24.19.0 | 518.65 ms | 442.18 ms | 14.7% |
| Node 26.4.0 | 481.01 ms | 402.67 ms | 16.3% |

These are Windows local, constructed-corpus component measurements. They do not establish H3 throughput, memory use under production ABI churn, end-to-end performance, or Wire qualification. The cache holds at most eight entries for exact canonical ABI bytes of at most 64 KiB and the exact revision profile; larger ABIs use the uncached path. It caches only immutable ABI-derived parsing and codec artifacts. Each row still validates physical bytes and selected ABI bytes and re-evaluates deployment interval, account, chain and source identity. It does not cache ABI authority, ownership or canonicality proofs.

The corrected checked-in invocation was independently repeated against code commit `dd5243780a78847ceba91b67b6194881b5b6dfa0`; its [raw record](wire31-checked-in-runner-benchmark.json) contains every run. Five interleaved rounds gave Node 24 medians 531.53 → 441.20 ms (17.0% elapsed reduction) and Node 26 medians 485.32 → 410.02 ms (15.5%). All outputs again had the same digest. These are the same local constructed-corpus limits described above.
