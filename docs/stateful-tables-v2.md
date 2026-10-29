# Original tables for stateful input version2

The optional provider `statefulTables` port offers `interfaceVersion:2` for
[Wire27](https://github.com/eosrio/hyperion-wire-plugin/issues/27) and
[SDK36](https://github.com/eosrio/hyperion-sdk/issues/36). Existing `normalizeDelta`
results remain unchanged. A stateful source-v2 host requires this exact capability;
it must not infer a scope or parse Wire physical row field names in Hyperion core.

Normalization reuses the source-pinned physical decoder, strict raw-input roundtrip,
deployment registry and ABI/value codecs. It retains the actual contract, logical
table, payer, presence, source position and applicable ABI deployment. A primary
record keeps the physical uint16 table namespace and complete key bytes. A secondary
record keeps its own namespace and full secondary/primary keys; its value is null
because that physical record has keys rather than a contract row value. Removed
primary records keep identity/payer and explicit null when no decoded value is available.
No KV identity acquires an empty scope or a key derived from a display value.

An ABI-dependent row first requests its original account's deployment. Missing or
incompatible deployments, raw/value mismatches and unknown required streams refuse.
Known non-table streams have an explicit ignore reason. This port does not establish
canonical source membership, complete selection, chronology, storage or API readiness.
The HAPI mixed owner, SDK owner/recovery version2 and source gates remain required.

The dependency pin is an explicit source-v2 engineering candidate. Tests use the
existing captured physical schema and constructed contract values/deployment contexts;
they do not establish real testnet contract compatibility, live worker acceptance,
AtomicAssets/AtomicMarket parity or a release profile. Existing frozen engineering
captures and consumer pins stay unchanged. Coordinate any release pin with the
complete Node/Rust package and actual source/owner/HTTP qualification.
