# Contributing

EOS Rio maintains this component as part of Hyperion 4.5. Work from a scoped GitHub issue and
follow the [shared architecture](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/architecture/hyperion-4.5.md) and applicable ADRs.

Describe delivered behavior, acceptance evidence, genuine dependencies and compatible component
versions. Keep public contracts in the SDK and database-native operations in adapters.

Run the complete checks listed in [README.md](README.md), including emitted Node artifacts,
the locked Rust component, shared conformance vectors, packed-content validation and local links.
Keep TypeScript 7.0.2, Bun 1.4.3, Node 22/24 and committed npm/Cargo lockfiles. Primitive conformance
does not establish host activation or testnet compatibility; add integration evidence with those slices.

Executable plugin upgrades are operator-initiated. Publish package versions and compatibility
claims only through explicit release work with qualification evidence.
