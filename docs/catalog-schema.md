# Catalog index schema

`plugins/index.json` is the machine-readable catalog that the Stratum in-app
**Plugin Directory** reads. It is a single JSON object with the following
shape (schema identifier `stratum-plugins-catalog/v1`).

## Top-level

```json
{
  "schema": "stratum-plugins-catalog/v1",
  "plugins": [ /* PluginEntry */ ]
}
```

## Plugin entry

```json
{
  "schema_version": 1,
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "One-line description",
  "author": "Author or org",
  "entry": "plugin.wasm",
  "permissions": ["file:read", "file:write"],
  "hooks": { "onSave": true },
  "repo": "https://github.com/owner/repo",
  "source": "examples/my-plugin",
  "sha256": "64 hex chars of the wasm blob",
  "download_url": "https://raw.githubusercontent.com/owner/repo/master/plugins/my-plugin/plugin.wasm"
}
```

| Field | Required | Rules |
|-------|----------|-------|
| `schema_version` | yes | Must be `1` (mirrors the manifest schema). |
| `id` | yes | Unique reverse-DNS id, ≤128 chars — must match the manifest id. |
| `name` | yes | Display name, ≤64 chars — must match the manifest name. |
| `version` | yes | Semver, ≤32 chars — must match the manifest version. |
| `description` | no | ≤512 chars. |
| `author` | no | ≤128 chars. |
| `entry` | yes | File name, default `plugin.wasm`. |
| `permissions` | yes | Array of valid manifest permissions. |
| `hooks` | no | Object `{ "on<Name>": bool }`. |
| `repo` | yes | Canonical source repository URL for the plugin. |
| `source` | no | Path within `repo` where the source lives (e.g. `examples/hello-world`). |
| `sha256` | yes | Lowercase hex SHA-256 of the published wasm blob. |
| `download_url` | yes | Direct URL to the wasm artifact (raw GitHub or release URL). |

## Invariants (enforced by CI)

1. `schema` must be exactly `stratum-plugins-catalog/v1`.
2. `plugins` must be a non-empty array.
3. Every plugin `id` must be unique.
4. Every plugin entry must have a **matching `plugins/<id>/plugin.wasm`** file in
   this repo whose `sha256` equals the recorded value.
5. The embedded manifest in that wasm must match the entry's manifest fields.
6. The `download_url` must point to that `plugins/<id>/plugin.wasm` path.
7. Every `id`/`name`/`version`/`permissions`/`hooks` must satisfy the manifest
   schema rules (see `docs/plugin-api.md`).
8. No plugin entry without a corresponding `plugins/<id>/` directory.

## Adding a plugin

1. Create `plugins/<id>/` containing `plugin.wasm` (embedded manifest) and
   `manifest.json`.
2. Add an entry to `plugins/index.json` with the real `sha256` (from
   `sha256sum`) and a `download_url` pointing at the artifact.
3. Run `./scripts/validate_plugin.sh` — it exits 0 only if all invariants hold.
4. CI re-runs the same validation on the pull request.
