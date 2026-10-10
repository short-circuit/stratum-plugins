# Stratum Plugins

Community plugin repository for [Stratum](https://github.com/short-circuit/stratum) — the
privacy-first, offline-capable PKM system.

Plugins are WebAssembly modules that run inside Stratum's sandboxed wasmtime runtime. They
extend the app — transforming notes on save, reacting to opens, making network requests —
without ever leaving the restricted host surface defined by the [plugin API
specification](https://github.com/short-circuit/stratum/blob/master/docs/advanced/plugins.md).

## What goes here

| Path | Purpose |
|------|---------|
| `plugins/` | Published, verified plugin artifacts. Each plugin id gets one directory. |
| `examples/` | Reference plugin source projects (the `hello-world` example is the canonical minimal template). |
| `docs/` | Author-facing documentation (manifest, WASM ABI, hooks). |
| `scripts/` | Validation and tooling (CI uses these locally and in GitHub Actions). |
| `.github/workflows/` | CI pipelines. |

The catalog `plugins/index.json` is the machine-readable index. The in-app **Plugin
Directory** (Stratum v1.0) reads this file to list, download, and install plugins.

## Plugin lifecycle

1. **Author** — copy `examples/hello-world/`, implement your hooks, declare permissions,
   declare hooks in the manifest, and build a `plugin.wasm`.
2. **Validate** — run `./scripts/validate_plugin.sh` locally. It checks the manifest
   against the host schema, validates `plugins/index.json`, verifies the WASM exports
   (`memory` + every declared hook), and confirms the `sha256` in the index matches the
   artifact.
3. **Submit** — open a pull request against this repo. CI re-runs the same validation.
   The maintainer verifies and merges; the plugin becomes installable from the in-app
   directory.

## Submitting a plugin

The contract is [PLUGIN_TEMPLATE.md](PLUGIN_TEMPLATE.md). To submit:

1. Fork this repo.
2. Create `plugins/<your-plugin-id>/` containing:
   - `plugin.wasm` — the built module (embedded manifest)
   - `manifest.json` — the same manifest (for tooling and the index)
3. Add your plugin's metadata to `plugins/index.json` (see the schema in
   [docs/catalog-schema.md](docs/catalog-schema.md)).
4. Add a `README.md` for your plugin and optionally move its source into `examples/`.
5. Open a pull request.

CI fails automatically on: missing template sections, invalid `index.json`, a manifest
that violates the host schema, missing `memory`/hook exports, or a `sha256` mismatch.

## Supported host API surface (summary)

The sandboxed ABI — four host functions, all typed `(i32, i32) -> i32` — is:

| Import | Permission required | Purpose |
|--------|--------------------|---------|
| `pkm.log` | none | Log a message through the host logger |
| `pkm.note_read` | `file:read` | Read a vault note's raw content |
| `pkm.note_write` | `file:write` | Create/overwrite a vault note |
| `pkm.http_request` | `network` | HTTP request (SSRF-guarded) |

Plus the real WASI preview1 surface — genuine `wasm32-wasip1` builds with Rust `std`
instantiate normally. No filesystem is preopened; vault I/O is exclusively through
`pkm.*`.

### Manifest (schema v1)

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

### Hooks (guest exports)

| Hook | Guest export | Payload |
|------|--------------|---------|
| `onSave` | `onSave` | `{"path","content"}` |
| `onOpen` | `onOpen` | `{"path"}` |
| `onLink` | `onLink` | `{"path","links"}` |
| `onSearch` | `onSearch` | `{"query","limit"}` |
| any other `on*` | `<name>` | `{"args":[]}` |

A plugin must export the hooked function **and** `memory`; it is invoked with
`(ptr, len)` pointing at the JSON payload in linear memory, and must write its JSON
response at memory offset 0 and return its length.

Full details: [PLUGIN_TEMPLATE.md](PLUGIN_TEMPLATE.md) · [docs/](docs/)
