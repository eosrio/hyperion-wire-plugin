# Contributing

EOS Rio maintains this component as part of Hyperion 4.5. Work from a scoped GitHub issue and
follow the [shared architecture](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/architecture/hyperion-4.5.md) and applicable ADRs.

Describe delivered behavior, acceptance evidence, genuine dependencies and compatible component
versions. Keep public contracts in the SDK and database-native operations in adapters.

This is a development scaffold. Run `python scripts/check-docs.py` for documentation changes.
Add runtime build, conformance and integration checks with the first implementation slice.
Scaffold CI does not establish runtime compatibility.

Executable plugin upgrades are operator-initiated. Publish package versions and compatibility
claims only through explicit release work with qualification evidence.
