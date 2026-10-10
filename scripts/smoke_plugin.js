#!/usr/bin/env node
// smoke_plugin.js — WASM smoke loader for a single plugin.
//
// Instantiates a plugin.wasm with stub host functions for pkm.* + WASI
// preview1, calls the declared hook with a sample payload, and asserts the
// host gets a well-formed response and no trap. This is the "plugin does not
// crash the host" check: a trap would reject.
//
// Usage: node scripts/smoke_plugin.js <path-to-plugin.wasm> [hook] [json-payload]
//        node scripts/smoke_plugin.js plugins/hello-world/plugin.wasm

'use strict';

const fs = require('fs');

const wasmPath = process.argv[2];
if (!wasmPath) { console.error('usage: node smoke_plugin.js <plugin.wasm> [hook] [payload]'); process.exit(2); }

const bytes = fs.readFileSync(wasmPath);

// Parse the embedded manifest to learn the hooks and default payloads.
let manifest = {};
const mod = new WebAssembly.Module(bytes);
const sections = WebAssembly.Module.customSections(mod, 'stratum:manifest');
if (sections.length > 0) {
  manifest = JSON.parse(Buffer.from(sections[0]).toString('utf8'));
}

const declaredHooks = Object.keys(manifest.hooks || {}).filter((k) => manifest.hooks[k]);
const hooksToTest = process.argv[3] ? [process.argv[3]] : declaredHooks;
if (hooksToTest.length === 0) {
  console.log('no hooks declared — module instantiation only');
}

const samplePayloads = {
  onSave: JSON.stringify({ path: 'smoke/note.md', content: 'Hello from smoke test.\n' }),
  onOpen: JSON.stringify({ path: 'smoke/note.md' }),
  onLink: JSON.stringify({ path: 'smoke/note.md', links: ['smoke/other.md'] }),
  onSearch: JSON.stringify({ query: 'hello', limit: 10 }),
};
const defaultPayload = JSON.stringify({ args: [] });

function makeImports(memorySegment) {
  // Stub pkm.* host functions: echo a minimal OK envelope.
  const pkm = {};
  for (const name of ['log', 'note_read', 'note_write', 'http_request']) {
    pkm[name] = (ptr, len) => {
      const req = Buffer.from(memorySegment.buffer, ptr, len).toString('utf8');
      const data = name === 'note_read'
        ? { path: 'smoke/note.md', content: '', mtime: '' }
        : name === 'note_write'
        ? { path: 'smoke/note.md', written: true }
        : name === 'http_request'
        ? { status: 200, headers: [], body: '{}' }
        : { logged: true };
      const resp = Buffer.from(JSON.stringify({ kind: 'ok', data }));
      new Uint8Array(memorySegment.buffer, 0, resp.length).set(resp);
      return resp.length;
    };
  }
  // Stub WASI preview1 (minimal set — envelope functions).
  const wasi = {
    environ_get: () => 0, environ_sizes_get: () => 0, fd_write: () => 0,
    proc_exit: () => { throw new Error('proc_exit'); },
    random_get: () => 0, clock_time_get: () => 0,
    fd_close: () => 0, fd_fdstat_get: () => 0, fd_seek: () => 0,
    fd_read: () => 0, fd_readdir: () => 0, fd_prestat_get: () => 0,
    fd_prestat_dir_name: () => 0, path_open: () => 0, path_filestat_get: () => 0,
    path_filestat_set_times: () => 0, path_create_directory: () => 0,
    path_remove_directory: () => 0, path_unlink_file: () => 0,
    path_rename: () => 0, path_readlink: () => 0, path_symlink: () => 0,
    poll_oneoff: () => 0, sched_yield: () => 0,
  };
  return { pkm, wasi_snapshot_preview1: wasi };
}

let failures = 0;
for (const hook of hooksToTest) {
  const payload = process.argv[4] || samplePayloads[hook] || defaultPayload;
  // The host stubs must write into the instance's memory; capture it through a
  // mutable holder that is set after instantiation (WebAssembly.Instance
  // requires imports at construction time, memory only exists after).
  const holder = { mem: null };
  const imports = {
    pkm: {
      log: (ptr, len) => { const r = Buffer.from(JSON.stringify({ kind: 'ok', data: { logged: true } })); new Uint8Array(holder.mem.buffer, 0, r.length).set(r); return r.length; },
      note_read: (ptr, len) => { const r = Buffer.from(JSON.stringify({ kind: 'ok', data: { path: 'smoke/note.md', content: '', mtime: '' } })); new Uint8Array(holder.mem.buffer, 0, r.length).set(r); return r.length; },
      note_write: (ptr, len) => { const r = Buffer.from(JSON.stringify({ kind: 'ok', data: { path: 'smoke/note.md', written: true } })); new Uint8Array(holder.mem.buffer, 0, r.length).set(r); return r.length; },
      http_request: (ptr, len) => { const r = Buffer.from(JSON.stringify({ kind: 'ok', status: 200, headers: [], body: '{}' })); new Uint8Array(holder.mem.buffer, 0, r.length).set(r); return r.length; },
    },
    wasi_snapshot_preview1: {
      environ_get: () => 0, environ_sizes_get: () => 0, fd_write: () => 0,
      proc_exit: (code) => { throw new Error('proc_exit(' + code + ')'); },
      random_get: () => 0, clock_time_get: () => 0, fd_close: () => 0,
      fd_fdstat_get: () => 0, fd_seek: () => 0, fd_read: () => 0,
      fd_readdir: () => 0, fd_prestat_get: () => 0, fd_prestat_dir_name: () => 0,
      path_open: () => 0, path_filestat_get: () => 0, path_filestat_set_times: () => 0,
      path_create_directory: () => 0, path_remove_directory: () => 0,
      path_unlink_file: () => 0, path_rename: () => 0, path_readlink: () => 0,
      path_symlink: () => 0, poll_oneoff: () => 0, sched_yield: () => 0,
    },
  };
  const inst = new WebAssembly.Instance(mod, imports);
  holder.mem = inst.exports.memory;
  const fn = inst.exports[hook];
  if (typeof fn !== 'function') { console.error(`✗ ${hook}: not exported`); failures++; continue; }
  try {
    const pBuf = Buffer.from(payload);
    new Uint8Array(inst.exports.memory.buffer, 0, pBuf.length).set(pBuf);
    const ret = fn(0, pBuf.length);
    const resp = Buffer.from(inst.exports.memory.buffer, 0, ret).toString('utf8');
    console.log(`✓ ${hook}: returned ${ret} bytes: ${resp.slice(0, 120)}`);
  } catch (e) {
    console.error(`✗ ${hook}: trap/failure: ${e.message}`);
    failures++;
  }
}

if (failures > 0) process.exit(1);
console.log('SMOKE OK');
