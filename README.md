# Hyperion Wire plugin

The EOS Rio Wire chain extension for Hyperion, coordinating required Node and Rust components
as one operator-managed package.

Status: Development scaffold for Hyperion 4.5. No plugin implementation or compatible release
is provided by this initial repository. Maintained by EOS Rio.

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

## First work

Start from the [Wire qualification profile](https://github.com/eosrio/hyperion-tools/issues/22).
Coordinate delivery through [release issue #24](https://github.com/eosrio/hyperion-tools/issues/24).

P08 in the approved issue batch defines the reproducible Wire testnet profile before extension
implementation. The [protocol investigation](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/architecture/hyperion-4.5-wire-protocol.md)
records source findings and qualification limits.

[Approved initial issue batch](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/roadmap/hyperion-4.5-initial-issues.md).

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
Repository checks validate scaffold documents and local links; runtime qualification is pending.
Licensed under [MIT](LICENSE).
