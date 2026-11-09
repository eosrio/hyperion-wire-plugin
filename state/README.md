# Wire state plugin

A Hyperion plugin for Wire contract state, built on the Hyperion 4.5 owner-v2 projection runtime. Its
first projection holds token balances, holdings and supply. It serves core `/v2/state/get_tokens` and
`/v2/state/get_top_holders`, through the host's legacy state route hook (`getLegacyStateRoutesV1`).

This is a development package. No release or compatibility claim is made.

## Separate from the protocol provider

This directory is its own package, `@eosrio/hyperion-wire-state`. The protocol provider's node and
Rust artifacts hash the repository's `src/`, `dist/`, `scripts/`, `crates/` and the root `package.json`,
and this plugin has no files in any of them. A change here leaves the provider's source and emitted
code byte-identical. Its artifacts still record the commit they were built from, in the source receipt
and manifests, as for any commit in this repository. So a host sees new provider artifact hashes only
when it moves its provider pin.

The plugin imports nothing from the provider: the host gives it already decoded rows. It installs as
`plugins/wire-state` in a Hyperion checkout, and its loaded files are hashed into the projection's
own declaration.

## What it projects

One projection, `wire-token-balances-v1`, selects the `accounts` and `stat` tables of `sysio.token`,
`sysio.liq` and `sysio.swap`. All three are token-shaped, and the legacy `get_tokens` listed balances
from all of them. Its record kinds:

| Kind | Key | Value |
|---|---|---|
| `balance` | `[contract, owner, symbol]` | exact amount, precision, last block |
| `holdings` | owner | the account's `{contract, symbol}` list |
| `stat` | `[contract, symbol]` | supply, maximum supply and issuer when the contract has them |
| `circulating` | `[contract, symbol]` | the sum of all balances |
| `holders:<contract>:<symbol>` | owner | one kind per ranked symbol, read whole to rank holders |

Amounts are int64 text in base units. Nothing goes through a float until the legacy `amount` field of
a response, and every response also carries `balance`, the exact asset text. WIRE's supply is
10^18 base units, beyond float precision.

### Key layout

Wire stores a scoped multi-index row under one KV key: the scope name, then the primary key, both
uint64 big-endian. Balances are keyed by owner, then symbol code. `sysio.token` scopes `stat` by
the symbol code itself. `sysio.liq` and `sysio.swap` key `stat` by the symbol code alone.

The [captured rows](fixtures/wire-testnet-token-rows.json) are 147 rows from the testnet delta index.
Each one is paired with the node's `get_table_rows` answer, and `tests/key-layout.test.mjs` checks that
every key decodes to the owner and symbol the node reports. Each contract's ABI is pinned by hash. A
redeployed ABI refuses until its layout is checked and added to `verifiedAbis`.

### Failing closed

Each block reads every touched key once and writes each changed key once. The block refuses, and the
host stops serving the projection, when any of these happens:

- a touched symbol's balances no longer add up to its supply;
- a row's key disagrees with its value;
- a deletion removes a balance that was never projected;
- a row comes from an unverified ABI.

`sysio.liq` indexes `stat` by token. Those secondary rows carry keys only, so they are skipped.

## Installing

```sh
npm ci --allow-git=all
npx tsc -p state/tsconfig.json
node state/scripts/install.mjs <hyperion-root>
```

[The install script](scripts/install.mjs) copies only `package.json` and `build/*.js` into
`<hyperion-root>/plugins/wire-state`, and enables it in `plugins/.state.json`. Install byte-identical
copies wherever the indexer and API run: the projection's declaration includes the plugin's code.

Then enable it in the chain configuration of both the indexer and the API:

```json
"plugins": {
  "wire-state": {
    "enabled": true,
    "tokens": {
      "rankedSymbols": [{"contract": "sysio.token", "symbol": "WIRE"}, {"contract": "sysio.token", "symbol": "SYS"}]
    }
  }
}
```

- `tokens.contracts` defaults to the three verified contracts.
- `tokens.verifiedAbis` adds checked ABI hashes per contract.
- `tokens.rankedSymbols` lists the symbols that `get_top_holders` can rank. Each one is its own record
  kind, and `get_top_holders` refuses any other symbol with 400.
- Changing this configuration changes the projection's declaration, so it needs a new
  `features.stateful_owner_v2.generation`.

The host also needs `features.stateful_owner_v2` with `maximumServingLagBlocks`, and its
complete-kind read for ranking.

## Checks

```sh
npx tsc -p state/tsconfig.json
node --test state/tests/*.test.mjs
```

Tests run on Node 24 and 26. They cover:

- the key layout against the captured rows;
- the reducer, against an in-memory port with the SDK's read-your-writes semantics;
- the route compositions and the plugin's registration;
- the install script.

Read the [repository README](../README.md) for the provider's own checks.
