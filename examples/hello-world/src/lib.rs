//! Hello World — the canonical minimal Stratum plugin.
//!
//! This is the reference for writing a real Rust plugin. It:
//!
//! 1. Builds with `cargo build --target wasm32-wasip1 --release` (stable Rust,
//!    `std` works because the host provides genuine WASI preview1).
//! 2. Embeds its manifest in the `stratum:manifest` custom section, so the
//!    resulting `plugin.wasm` is complete and self-describing — copy it into a
//!    vault at `.pkm/plugins/hello-world/plugin.wasm` and it is discovered,
//!    validated, and enabled from the Plugins UI.
//! 3. Implements the `onSave` hook (the host ABI: `(i32, i32) -> i32`).
//! 4. Uses the `pkm.*` host API for all vault I/O — never the host process's
//!    filesystem directly. `pkm.log`, `pkm.note_read`, `pkm.note_write`,
//!    `pkm.http_request` are the only sanctioned way to touch the vault.
//!
//! The WASI preview1 runtime (fed by the same host) makes `std`'s CRT
//! happy — heap allocation, `eprintln!`, clocks all work. No filesystem is
//! preopened: raw `std::fs` does not see the vault. Use the host API instead.

use std::slice;

// ---------------------------------------------------------------------------
// Manifest (embedded in the wasm as a custom section)
// ---------------------------------------------------------------------------
//
// The manifest is the plugin's contract with the host: schema version, unique
// reverse-DNS id, display name, semver version, the capabilities it needs
// (`permissions`), and the hooks it wants to receive. `#[link_section]` emits
// this literal as the `stratum:manifest` custom section in the compiled wasm —
// the same artifact that installs also declares itself.
//
// The byte-array length below MUST match the literal exactly (wasm custom
// sections cannot carry a `&str` indirection). Keep them in lockstep.
// REBUILD NOTE: after editing the literal, update the array length to match.
#[used]
#[link_section = "stratum:manifest"]
static MANIFEST: [u8; 248] = *b"{\"schema_version\":1,\"id\":\"com.example.hello-world\",\"name\":\"Hello World\",\"version\":\"0.1.0\",\"author\":\"Stratum Community\",\"description\":\"Logs note metadata on save and demonstrates the pkm host API\",\"permissions\":[\"file:read\"],\"hooks\":{\"onSave\":true}}";

// ---------------------------------------------------------------------------
// Host API imports (documented in PLUGIN_TEMPLATE.md / docs)
// ---------------------------------------------------------------------------
//
// Every host function has the type (i32, i32) -> i32. The first pair is a
// pointer + byte length locating a UTF-8 JSON request in *linear memory*. The
// host writes the JSON response envelope at memory offset 0 and returns its
// byte length.
//
// The wasm import name is the Rust identifier, so the externs below are named
// exactly `log` / `note_read` — matching the `pkm.*` imports the host linker
// registers.
#[link(wasm_import_module = "pkm")]
extern "C" {
    /// `pkm.log` — no permission required. Payload: `{"level","message"}`.
    fn log(ptr: i32, len: i32) -> i32;
    /// `pkm.note_read` — requires `file:read`. Payload: `{"path"}`.
    fn note_read(ptr: i32, len: i32) -> i32;
}

/// A host call site: bytes at `result[0..result.len()]` after the call return
/// the host's JSON response envelope in linear memory at offset 0.
struct HostResp {
    len: i32,
}

fn call_host(f: unsafe extern "C" fn(i32, i32) -> i32, req: &[u8]) -> HostResp {
    let len = unsafe { f(req.as_ptr() as i32, req.len() as i32) };
    HostResp { len }
}

/// Read `len` bytes of linear memory starting at offset 0 (the host response
/// area) into an owned `Vec`.
///
/// On wasm32 there is no host null page: linear-memory address 0 is valid and
/// dereferenceable, so `0 as *const u8` is correct despite rustc's
/// `invalid_null_arguments` lint (a host-address-space concept that does not
/// apply here).
#[allow(invalid_null_arguments)]
fn read_linear(len: i32) -> Vec<u8> {
    if len <= 0 {
        return Vec::new();
    }
    let src = unsafe { slice::from_raw_parts(0 as *const u8, len as usize) };
    src.to_vec()
}

/// Write `data` to linear memory starting at offset 0 (the host reads the
/// hook's return length bytes from here).
///
/// Uses volatile byte stores so LLVM cannot elide the write as dead — the
/// host observes memory across the wasm boundary and the write's effects are
/// not visible to the optimizer.
#[allow(invalid_null_arguments)]
fn write_linear(data: &[u8]) {
    if data.is_empty() {
        return;
    }
    let dst = 0 as *mut u8;
    for (i, &b) in data.iter().enumerate() {
        unsafe { dst.add(i).write_volatile(b) };
    }
}

/// Parse a host response envelope and return `(kind, code)` for logging.
fn response_summary(bytes: &[u8]) -> (String, String) {
    match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(v) => {
            let kind = v
                .get("kind")
                .and_then(|k| k.as_str())
                .unwrap_or("?")
                .to_string();
            let code = v
                .get("code")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default();
            (kind, code)
        }
        Err(_) => ("unparseable".to_string(), String::new()),
    }
}

/// The `onSave` hook. The host calls this synchronously after a note is saved,
/// with a JSON payload `{"path": "<vault-relative path>", "content": "<full
/// text>"}` located at `(ptr, len)` in linear memory.
///
/// Returns the byte length of the JSON response the plugin left at offset 0.
///
/// This plugin is read-only and mostly diagnostic: it logs the note path and
/// statistics through `pkm.log`. It also demonstrates `pkm.note_read` by re-
/// reading the note after save.
#[no_mangle]
pub extern "C" fn onSave(ptr: i32, len: i32) -> i32 {
    // Linear-memory offset 0 is the ABI scratch area: the host delivers the
    // hook payload there, and any host callback overwrites it with its
    // response. Copy the payload into our own heap before calling anything.
    let payload_src = unsafe { slice::from_raw_parts(ptr as *const u8, len as usize) };
    let payload = serde_json::from_slice::<serde_json::Value>(payload_src);

    let (path, content) = match payload {
        Ok(v) => {
            let path = v
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();
            let content = v
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            (path, content)
        }
        Err(_) => {
            let out = serde_json::json!({ "error": "invalid_onSave_payload" });
            let bytes = serde_json::to_vec(&out).unwrap_or_default();
            write_linear(&bytes);
            return bytes.len() as i32;
        }
    };

    if path.is_empty() {
        let out = serde_json::json!({ "error": "missing_path" });
        let bytes = serde_json::to_vec(&out).unwrap_or_default();
        write_linear(&bytes);
        return bytes.len() as i32;
    }

    // Demonstrate pkm.note_read (requires file:read — declared in the
    // manifest). The host writes its response envelope at offset 0; the value
    // returned here is that response's length.
    let read_req = serde_json::json!({ "path": path });
    let read_bytes = serde_json::to_vec(&read_req).unwrap_or_default();
    let read_len = call_host(note_read, &read_bytes).len;
    let read_resp = read_linear(read_len);
    let (read_kind, read_code) = response_summary(&read_resp);

    // Log through the host API (always allowed, no permission required).
    let wc = content.chars().count();
    let lc = content.lines().count();
    let log_req = serde_json::json!({
        "level": if read_kind == "ok" { "info" } else { "warn" },
        "message": format!(
            "[hello-world] onSave path={} chars={} lines={} note_read={}{}",
            path, wc, lc, read_kind,
            if read_code.is_empty() { String::new() } else { format!(" ({read_code})") }
        ),
    });
    let log_bytes = serde_json::to_vec(&log_req).unwrap_or_default();
    call_host(log, &log_bytes);

    // Hook response — written to offset 0 (the host reads `return` bytes from
    // offset 0). Small, diagnostics-only; payload I/O already happened through
    // the host API.
    let out = serde_json::json!({
        "path": path,
        "chars": wc,
        "lines": lc,
        "note_read_status": read_kind,
    });
    let out_bytes = serde_json::to_vec(&out).unwrap_or_default();
    write_linear(&out_bytes);
    out_bytes.len() as i32
}

// No Rust `main` — this is a library module the host drives by calling the
// exported hook. The `std` runtime (allocator, panic handler) is linked in by
// the wasm32-wasip1 target; a panic unwinds through the ABI boundary and is
// contained by the host (never crashes the host process).
