# Plugin API (summary mirror)

The authoritative, normative contract for the Stratum plugin system is
[`docs/advanced/plugins.md`](https://github.com/short-circuit/stratum/blob/master/docs/advanced/plugins.md)
in the main stratum repository (ADR-0004). This directory mirrors the parts a
plugin author needs, so authors do not need the main repo.

- [`plugin-api.md`](plugin-api.md) — manifest schema, WASM binary spec, host
  function ABI, permissions, sandbox contract, hooks, error codes, testing
  instructions.
- [`catalog-schema.md`](catalog-schema.md) — the `plugins/index.json` catalog
  schema that the in-app Plugin Directory reads, plus the invariants CI
  enforces.

## Quick facts

- **Manifest** (schema v1, embedded in the `stratum:manifest` custom section):
  `schema_version, id, name, version, description, author, entry, permissions[],
  hooks{}`.
- **Target:** `wasm32-wasip1` (canonical; genuine WASI preview1). Import-free
  `wasm32-unknown-unknown` also works.
- **ABI:** guest exports `memory` + hook functions `(i32,i32)->i32`; host
  imports are `pkm.log`, `pkm.note_read`, `pkm.note_write`,
  `pkm.http_request` plus WASI preview1. No `main`, no `plugin_main`.
- **Permissions:** `file:read`, `file:write`, `network`, `git`, `exec`, `all`.
- **Isolation:** plugin traps are contained — the host logs and continues; a
  plugin crash never aborts the surrounding operation or crashes the host.
