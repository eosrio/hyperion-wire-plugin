# Hyperion Wire plugin: agent guidance

Read [README.md](README.md), the [architecture definition](https://github.com/eosrio/hyperion-tools/blob/a36fda12ba813968ce361e85893206d8f5bceb0f/docs/architecture/hyperion-4.5.md)
and applicable ADRs. Work from the approved release plan and scoped linked issues.

Adapt protocol conventions before generic decoding and preserve original keys and provenance.
Qualify required Node and Rust paths together. Do not port the Wire pseudo-fork wholesale or infer
launch compatibility from source inspection or an unselected upstream tag.

Keep accepted release constraints, implementation status and qualification evidence distinct.
A scaffold or green documentation check is not a working extension. Add appropriate runtime
checks with implementation. Do not publish versions or compatibility claims implicitly.

Use TypeScript 7.0.2 and Bun 1.4.4 from `.bun-version` for the complete project check.
Keep npm installation from the committed lockfile, TypeScript artifact emission, Node 22/24
checks, and the existing locked Rust/conformance checks. The checker pin does not qualify Bun
as the production runtime.
