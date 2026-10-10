# Hello World

Minimal reference Stratum plugin. Demonstrates the complete authoring surface:

- Embedded manifest in the `stratum:manifest` custom section
- The `onSave` hook (host ABI `(i32, i32) -> i32`)
- The `pkm.log` and `pkm.note_read` host functions
- correct permission declaration (`file:read`)

It is intentionally read-only and diagnostic: on every save it logs the note
path, character and line counts, and the result of re-reading the note via the
host API.

## Build

```sh
cargo build --release --target wasm32-wasip1 \
  --manifest-path examples/hello-world/Cargo.toml
cp examples/hello-world/target/wasm32-wasip1/release/stratum_plugin_hello_world.wasm \
   plugins/hello-world/plugin.wasm
```

## Install

Copy `plugin.wasm` into a vault at `.pkm/plugins/hello-world/plugin.wasm`, open
the vault, and enable it from the Plugins panel. The manifest is embedded, so
no sidecar file is needed.

## How it works

1. The host calls `onSave(ptr, len)` after every note save with the JSON
   payload `{"path", "content"}` written into linear memory.
2. The plugin parses the payload, re-reads the note through `pkm.note_read`
   (permission `file:read`), logs statistics through `pkm.log`, and writes a
   small JSON response at linear-memory offset 0.
3. The host reads `return_len` bytes from offset 0. If the plugin traps, the
   host logs and continues — the save is never aborted.

See [PLUGIN_TEMPLATE.md](../../PLUGIN_TEMPLATE.md) for the full contract and
[docs/](../../docs/) for the catalog and authoring guides.
