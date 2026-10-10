# Stratum Plugin API Specification

> **NORMATIVE REFERENCE.** The authoritative contract for Stratum's plugin system is
> `docs/advanced/plugins.md` in the [stratum
> repo](https://github.com/short-circuit/stratum/blob/master/docs/advanced/plugins.md)
> (ADR-0004). This document mirrors it for plugin authors; where a discrepancy exists,
> the upstream spec wins.

Plugins are WebAssembly modules executed in an embedded wasmtime runtime, fully
sandboxed from the host filesystem and network. A plugin declares the capabilities it
needs; the host enforces them. A plugin touches the vault exclusively through the host
function ABI below.

## Packaging

A plugin is **one file**: `plugin.wasm`, a wasm32 core module (unsuffixed, **not** a
component) with an embedded JSON manifest in the custom section `stratum:manifest`.

It is placed at `<vault>/.pkm/plugins/<id>/plugin.wasm`. For compatibility a manifest is
also accepted from a sibling `plugin.wasm.manifest.json`; when both exist, the embedded
manifest wins.

## Manifest schema (v1)

```json
{
  "schema_version": 1,
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "Optional one-line description",
  "author": "Optional author or org",
  "entry": "plugin.wasm",
  "permissions": ["file:read", "file:write", "network"],
  "hooks": { "onSave": true }
}
```

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `schema_version` | integer | yes | Must be `1`. |
| `id` | string | yes | Unique reverse-DNS id — `^[A-Za-z0-9][A-Za-z0-9._-]*$`, ≤128 chars. |
| `name` | string | yes | Display name, ≤64 chars. |
| `version` | string | yes | Semver, ≤32 chars. |
| `description` | string | no | ≤512 chars. |
| `author` | string | no | ≤128 chars. |
| `entry` | string | yes | File name of the wasm module. Default `plugin.wasm`. |
| `permissions` | array<string> | yes | See Permission model. Unknown ⇒ rejected. |
| `hooks` | object | no | Default: no hooks. Keys `on*`, boolean values. |

Unknown fields are ignored (forward compatibility).

## WASM binary spec

- **Target:** `wasm32-wasip1` is the canonical target. Genuine WASI preview1 modules —
  including Rust `std` cdylibs whose CRT references WASI symbols — instantiate with real
  signatures. Import-free `wasm32-unknown-unknown` modules also work.
- **Library type:** `cdylib`. There is **no `main`**; the host drives the plugin by
  calling exported hook functions.
- **Exports required:** `memory` and every hook function the manifest declares
  (e.g. `onSave`), each typed `(i32, i32) -> i32`.
- **Imports allowed:** `pkm.*` host functions and WASI preview1 only. Any other import
  namespace ⇒ instantiation fails with `PluginLoadError`.
- **no_std** is OK if you only use the `pkm.*` ABI; using `std` requires WASI (the
  runtime provides real WASI preview1 implementations).

### Entry / init contract

There is no `plugin_main` and no required `_initialize` export in the host runtime's
current implementation. A plugin is **initialized lazily**: the host instantiates the
module, checks it exports the requested hook and `memory`, then calls the hook with a
JSON payload `(ptr, len)` into linear memory. The hook writes its JSON response at
memory **offset 0** and returns its byte length. Mutating globals/statics at instantiation
time is the initializer.

## Host function ABI

Every host function has WASM type `(param i32 i32) (result i32)`:

- `(param)` — pointer and byte length of a UTF-8 JSON request in the plugin's linear
  memory.
- `(result)` — byte length of the JSON response the host wrote at **offset 0** (memory is
  grown as needed).

| Import name | Permission | Purpose |
|-------------|-----------|---------|
| `pkm.log` | none (always allowed) | Log a message |
| `pkm.note_read` | `file:read` | Read a vault-relative note |
| `pkm.note_write` | `file:write` | Create/overwrite a vault-relative note |
| `pkm.http_request` | `network` | HTTP request with SSRF guard |

All requests and responses are JSON envelopes bounded at **1 MiB** (`HOST_PAYLOAD_MAX`).
`pkm.note_read`/`note_write` are vault-relative with path-traversal guards; a failed
write propagates (never reported as success). `http_request` enforces a timeout (default
10000 ms, bounded 1..=60000), an SSRF guard (vault `network.allowlist` + private
loopback/LAN resolution), and returns HTTP status 400..=599 as an error.

## Declared permissions

| Permission | Protects | Host functions / behavior |
|------------|----------|---------------------------|
| `file:read` | reading vault notes | `pkm.note_read` |
| `file:write` | writing vault notes | `pkm.note_write` |
| `network` | HTTP egress | `pkm.http_request` |
| `git` | Git operations (2/2) | lifecycle-gated |
| `exec` | Running subprocesses | lifecycle-gated |
| `all` | every capability above | all host functions |

Any other string ⇒ manifest rejected with `ConfigError`. A host function invoked without
its permission surfaces `Err { "code": "plugin_denied" }` to the plugin — it never aborts
the guest. `pkm_core::PluginConfig.permissions` is an enablement/config override only;
grants come from the manifest.

## Sandbox contract

- **No filesystem preopen.** WASI sees an empty host; `std::fs` does not see the vault.
  Use `pkm.note_read`/`pkm.note_write`.
- **No host crash on panic.** Hook dispatch is synchronous within the triggering host
  operation; a hook that traps or fails is logged and skipped — it never aborts the
  surrounding operation and never crashes the host. This is the sandbox isolation
  contract: plugin crashes are contained.
- **Errors are envelopes, not traps.** A host callback that throws (trap, guest OOM,
  missing permission, invalid request) is converted into `Err` in the response envelope;
  it never propagates a trap to the guest.
- **Hook dispatch** runs synchronously within the triggering host operation. `onSave` is
  dispatched from the page-save flow, `onOpen` from page-open, `onLink` from save (link
  targets extracted via the markdown linker), `onSearch` from full-text search.

## Hooks

| Hook | Guest export | Host payload |
|------|--------------|--------------|
| `onSave` | `onSave` | `{"path","content"}` |
| `onOpen` | `onOpen` | `{"path"}` |
| `onLink` | `onLink` | `{"path","links"}` |
| `onSearch` | `onSearch` | `{"query","limit"}` |
| any other `on*` | `<name>` | `{"args":[]}` |

A hook whose guest export is missing is a no-op (logged at `debug`). A plugin may use a
subset of hooks; declaration is via the manifest `hooks` map.

## Error codes (ABI-frozen)

`plugin_denied` · `plugin_not_found` · `plugin_load_error` · `plugin_runtime_error` ·
`note_not_found` · `note_write_failed` · `http_transport` · `http_timeout` ·
`http_ssid` · `http_status` · `invalid_argument` · `config_error` · `internal`

## Testing

- `./scripts/validate_plugin.sh` — local full validation (template sections, index
  schema, manifest schema, WASM exports, sha256).
- `./scripts/smoke_plugin.mjs` — WASM smoke loader: instantiate, call the declared hook
  with a sample payload, assert no trap.
- CI runs both on every push/PR and must fail on any violation (see
  `.github/workflows/plugin-ci.yml`).
