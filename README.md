# Hyperion Wire plugin

The EOS Rio Wire chain extension for Hyperion, coordinating required Node and Rust components
as one operator-managed package.

Status: Private development implementation of Wire ABI, value and SHiP codecs for
Hyperion 4.5. The Node and Rust components share source-pinned profiles and fixture corpora.
This is not an activated Hyperion protocol provider or a compatible release. Maintained by EOS Rio.

Read the [architecture definition](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/architecture/hyperion-4.5.md),
[ADRs](https://github.com/eosrio/hyperion-tools/tree/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/adr)
and [release roadmap](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/roadmap/hyperion-4.5.md).

[SDK, runtime and adapter source homes](https://github.com/eosrio/hyperion-tools/blob/458e1127b99c025251055e160129010edcecc78a/docs/architecture/hyperion-4.5-component-homes.md)
define package ownership; assigned homes are not implementation or release-support claims.

## Scope

- Select protocol providers before decoding affected data. Keep chain-specific conventions out
  of generic contract projections.
- Preserve complete keys and source provenance, with consistent behavior across applicable
  live, bulk, Node and Rust decode paths.
- Working support is mandatory for 4.5 and must be qualified on the new testnet launched with
  Wire's contracts.
- Exact node, contracts, genesis/build inputs and extension versions still need selection.
  Investigation revisions are not accepted release pins.
- Native protocol changes may use controlled restarts; operators do not manage the Node and Rust
  pieces as separate plugins.

## Implemented development slice

[Issue #1](https://github.com/eosrio/hyperion-wire-plugin/issues/1) supplies:

- Exact conversions between uint32 block slots and Unix milliseconds for the pinned engineering
  profile: 2025 epoch, 500 ms slots. Invalid, fractional, unaligned and out-of-range inputs fail.
- Lossless identities for already-decoded primary and secondary KV primitives. Identity uses the
  chain, raw account value, authoritative table/index ID and all key bytes. Table ID zero is valid.
  Both record kinds retain payer, byte fields, deletion intent and supplied source/ABI provenance.
- Equivalent Node and internal Rust implementations, a shared vector corpus, and packed-content
  checks for the private source bundle. Rust is an internal component, not a second plugin install.

[Issue #2](https://github.com/eosrio/hyperion-wire-plugin/issues/2) adds native binary meta-ABI
and contract-value codecs, both protobuf lengths, all six crypto carrier families, SHiP
requests/ACKs/results and nested payloads, and deployment-scoped numeric table resolution.
The corpus retains official offline conversions, a real node capture and separately labeled
source-derived cases. An upstream delta count defect is handled explicitly by a pinned
transport compatibility path; the generic decoder rejects the incomplete framing.

The [captured application workload](fixtures/codec/application-capture-20261020/README.md)
adds 119 original blocks with deployed contracts, complete primary/secondary KV bytes,
protobuf actions/results, distinct inline origins and an ABI replacement. Its 1,267 operations
are compared across Node/Rust with independent byte-level and official-clio expectations.

The APIs are package-local development entry points, not the public SDK protocol-provider contract.
The SDK provider's [native-genesis verifier](docs/native-genesis.md) now checks the bounded
6508 initial source inventory and returns native ABI facts from the actual testnet fixture.
Canonical initialization and serving authority remain host responsibilities; this is a Node-only
genesis verification slice with explicit key-family limits.
The [native-action source verifier](docs/native-actions.md) adds coordinated Node/Rust handling
of implicit `onblock` headers independently of deployed contract ABIs. The explicitly selected
`wire-sysio-6508c9e8-native-engineering-v1` profile exposes this capability through the normal
provider and requires native interface 1 in its inert descriptor. Both older profiles remain
native-inactive, and the default codec profile is unchanged. This engineering selection does not
activate services or establish launch support.
The host supplies the canonical ABI deployment view. Worker activation, storage writes, fork
recovery and native installation remain separate work. See [the codec contract](docs/codecs.md),
[the primitive contract](docs/primitives.md), [codec fixture provenance](docs/codec-provenance.md)
and [source provenance](docs/protocol-sources.md). Host integration is tracked in
[History API #212](https://github.com/eosrio/hyperion-history-api/issues/212) and
[tools #41](https://github.com/eosrio/hyperion-tools/issues/41).

## Development checks

Use TypeScript 7.0.2 and Bun 1.4.4 under the
[shared toolchain policy](https://github.com/eosrio/hyperion-tools/blob/main/docs/architecture/hyperion-4.5-typescript-toolchain.md).
Node 22/24 execute the emitted artifacts; Bun is the checker. Install from the committed npm
lockfile and use the committed Cargo lockfile:

```sh
npm ci --allow-git=all
npm run typecheck
npm test
cargo test --locked
npm run test:cross
npm run check:fixtures
python -B -m unittest discover -s tests -p 'test_*capture*.py'
npm run test:package
python scripts/check-docs.py
```

The package remains private. No version is published and no compatibility catalog claim is made.
The [bounded range capture driver](docs/range-capture.md) retains real SHiP input and official
CLI observations from a source-pinned node; its raw capture does not certify application coverage
or the initial ABI frontier.
The source bundle is checked as one coordinated package; platform/native artifact distribution
and operator activation remain [#3](https://github.com/eosrio/hyperion-wire-plugin/issues/3).

## Qualification and next work

Start from the [Wire qualification profile](https://github.com/eosrio/hyperion-tools/issues/22).
Coordinate delivery through [release issue #24](https://github.com/eosrio/hyperion-tools/issues/24).

P08 in the approved issue batch tracks the reproducible Wire testnet profile. Engineering fixtures
can precede final launch pins. The [protocol investigation](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/architecture/hyperion-4.5-wire-protocol.md)
records source findings and qualification limits.

[Approved initial issue batch](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/roadmap/hyperion-4.5-initial-issues.md).

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
Primitive conformance, host integration and release qualification are separate gates. The selected
new testnet supplies engineering captures; full worker, fork and release qualification remain open.
Licensed under [MIT](LICENSE).
## SDK integration

The [SDK protocol provider](docs/provider.md) exposes the Wire codecs and
deployment-bound KV normalization through one coordinated Node/Rust package.
Its inert descriptor is verified before loading executable code. Current pins
remain engineering inputs; release and live testnet qualification are pending.

[Issue #8](https://github.com/eosrio/hyperion-wire-plugin/issues/8) adds
[ABI source observations](docs/abi-observations.md) from unfiltered SHiP input. Both components
preserve action execution evidence, native ABI mutations and block-end account state as separate
facts. These observations feed the host journal; canonical coverage and proof-carrying decoding
remain open in [History API #213](https://github.com/eosrio/hyperion-history-api/issues/213).
