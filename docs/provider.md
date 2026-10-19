# SDK protocol provider

The `@eosrio/hyperion-wire-plugin/provider` export provides
`createProtocolProvider(profileId)` through the independently pinned Hyperion SDK.
The profile must be explicit. Each provider and SHiP session owns its codec state.
The existing ABI/value exports remain available.

Read `@eosrio/hyperion-wire-plugin/protocol-provider.json` before importing the
factory. It declares the complete Node/Rust component set for each engineering
profile. The host verifies both artifact manifests and every listed file before
executable import, then checks SDK and host compatibility and exact component
pins. The generator hashes actual packaged bytes; the descriptor is generated
during build/prepare from the exact Git revision. Builds containing uncommitted
source have `sourceModified: true` and must be rejected for activation.

The Node artifact contains emitted JavaScript/declarations, package metadata and
an exact copy of the npm dependency lock. The Rust artifact is an explicitly
marked **source-only engineering bundle**, not a qualified native executable.
Both are installed through one operator package. These hashes detect mismatched
installed artifacts; operator trust and executable installation remain separate.

The host decodes every required delta stream before choosing downstream handlers.
Unknown streams fail explicitly. Known non-KV streams pass through. Primary and
secondary KV streams request a position-bound contract ABI from the host using
`abi-required`, then normalize against that exact deployment. No current/head ABI
fallback exists. The provider checks deployment interval, binary ABI metadata,
numeric table/index mapping and raw row bytes. Complete keys, physical row,
payer, presence, profile and source position survive normalization. A removed row
does not require decoding an absent value. ABI bodies belong in deployment
storage and are not copied into every history record.

SHiP sessions use the selected profile for request, envelope, block, trace, delta
and row decoding. The pinned resource-stream count correction is handled by the
underlying Wire codec; it never broadens the generic value decoder. Raw input
must remain available to the host's replay/error path.

Tests cover the captured SHiP bundle, long compound and secondary identities,
deletes, exact deployment bounds, metadata/raw mismatch, independent sessions,
unknown required streams and packed installed artifact hashes. These engineering
fixtures do not qualify production worker recovery, direct disk bulk/snapshot
consumers, a new testnet, or the final operator distribution. See
[codec provenance](codec-provenance.md) and [codec behavior](codecs.md).
