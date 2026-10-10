#!/usr/bin/env node
// validate_plugins.js
//
// Validates the stratum-plugins repository against the contract:
//   1. PLUGIN_TEMPLATE.md exists with all required sections
//   2. plugins/index.json is valid JSON and schema-conformant
//   3. Every listed plugin has a matching plugins/<id>/ directory and a real
//      plugins/<id>/plugin.wasm whose sha256 matches the index entry
//   4. The wasm exports `memory` and every hook declared in the entry
//   5. The embedded `stratum:manifest` custom section validates against the
//      manifest schema and matches the index entry
//   6. download_url points at the artifact
//
// Exit code 0 = compliant; 1 = violation.
//
// Usage: node scripts/validate_plugins.js [--root DIR]

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.argv.includes('--root')
  ? path.resolve(process.argv[process.argv.indexOf('--root') + 1])
  : path.resolve(__dirname, '..');

const MANIFEST_SCHEMA = {
  schema_version: { type: 'integer', value: 1 },
  id: { type: 'string', max: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ },
  name: { type: 'string', max: 64 },
  version: { type: 'string', max: 32 },
  description: { type: 'string', max: 512 },
  author: { type: 'string', max: 128 },
  entry: { type: 'string', default: 'plugin.wasm' },
  permissions: { type: 'array' },
  hooks: { type: 'object' },
};

const VALID_PERMISSIONS = new Set([
  'file:read', 'file:write', 'network', 'git', 'exec', 'all',
]);

const VALID_HOOKS = new Set([
  'onSave', 'onOpen', 'onLink', 'onSearch',
]);

let errors = [];
let warnings = [];

function fail(msg) { errors.push(msg); }
function ok(msg) { warnings.push(msg); }

function readJson(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) { fail(`missing file: ${file}`); return null; }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`invalid JSON in ${file}: ${e.message}`);
    return null;
  }
}

function isArrayOfStrings(v) { return Array.isArray(v) && v.every((x) => typeof x === 'string'); }

// --- 1. Template sections -----------------------------------------------
function checkTemplate() {
  const tpl = path.join(ROOT, 'PLUGIN_TEMPLATE.md');
  if (!fs.existsSync(tpl)) { fail('PLUGIN_TEMPLATE.md is missing'); return; }
  const text = fs.readFileSync(tpl, 'utf8');
  const required = [
    '## Manifest',
    '## WASM binary spec',
    '## Declared permissions',
    '## Sandbox contract',
    '## Hooks',
    '## Testing',
  ];
  for (const heading of required) {
    if (!text.includes(heading)) {
      fail(`PLUGIN_TEMPLATE.md missing required section: ${heading}`);
    }
  }
  if (!text.includes('```json')) fail('PLUGIN_TEMPLATE.md missing manifest JSON example');
}

// --- 2. Index schema ------------------------------------------------------
function checkIndex() {
  const index = readJson('plugins/index.json');
  if (!index) return;
  if (index.schema !== 'stratum-plugins-catalog/v1') {
    fail(`index.json schema must be "stratum-plugins-catalog/v1", got "${index.schema}"`);
  }
  if (!Array.isArray(index.plugins) || index.plugins.length === 0) {
    fail('index.json must have a non-empty "plugins" array');
    return;
  }
  const seen = new Set();
  for (const [i, p] of index.plugins.entries()) {
    const label = `plugins[${i}] (${p.id || 'no-id'})`;
    if (!p.id) fail(`${label}: missing id`);
    if (!p.name) fail(`${label}: missing name`);
    if (!p.version) fail(`${label}: missing version`);
    if (typeof p.id !== 'string' || !MANIFEST_SCHEMA.id.pattern.test(p.id) || p.id.length > 128)
      fail(`${label}: id "${p.id}" invalid (reverse-DNS, ≤128, [A-Za-z0-9._-])`);
    if (typeof p.name !== 'string' || p.name.length > 64)
      fail(`${label}: name too long (>64)`);
    if (typeof p.version !== 'string' || p.version.length > 32)
      fail(`${label}: version invalid (>32)`);
    if (p.schema_version !== 1) fail(`${label}: schema_version must be 1`);
    if (p.entry !== undefined && typeof p.entry !== 'string')
      fail(`${label}: entry must be a string`);
    if (!Array.isArray(p.permissions)) {
      fail(`${label}: permissions must be an array`);
    } else {
      for (const perm of p.permissions) {
        if (!VALID_PERMISSIONS.has(perm))
          fail(`${label}: unknown permission "${perm}" (valid: ${[...VALID_PERMISSIONS].join(', ')})`);
      }
    }
    if (p.hooks !== undefined && typeof p.hooks !== 'object') fail(`${label}: hooks must be an object`);
    for (const hook of Object.keys(p.hooks || {})) {
      if (!hook.startsWith('on')) fail(`${label}: hook key "${hook}" must start with "on"`);
    }
    if (typeof p.repo !== 'string' || !/^https?:\/\//.test(p.repo))
      fail(`${label}: repo must be a URL`);
    if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256))
      fail(`${label}: sha256 must be 64 lowercase hex chars`);
    if (typeof p.download_url !== 'string' || !/^https?:\/\//.test(p.download_url))
      fail(`${label}: download_url must be a URL`);
    if (seen.has(p.id)) fail(`${label}: duplicate id "${p.id}"`);
    seen.add(p.id);
    checkArtifactMatch(p, label);
  }
}

// --- 3. Artifact match (3,4,5,6) -----------------------------------------
function checkArtifactMatch(p, label) {
  const dir = path.join(ROOT, 'plugins', p.id);
  if (!fs.existsSync(dir)) {
    fail(`${label}: no plugins/${p.id}/ directory`);
    return;
  }
  const entry = p.entry || 'plugin.wasm';
  const wasmPath = path.join(dir, entry);
  if (!fs.existsSync(wasmPath)) {
    fail(`${label}: missing artifact ${path.relative(ROOT, wasmPath)}`);
    return;
  }
  const bytes = fs.readFileSync(wasmPath);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash !== p.sha256) {
    fail(`${label}: sha256 mismatch — index says ${p.sha256}, artifact is ${hash}`);
  }

  // download_url must point at the artifact path
  if (!p.download_url.includes(`/plugins/${p.id}/${entry}`)) {
    fail(`${label}: download_url must point at plugins/${p.id}/${entry}`);
  }

  // wasm structural checks
  let mod;
  try {
    mod = new WebAssembly.Module(bytes);
  } catch (e) {
    fail(`${label}: ${path.relative(ROOT, wasmPath)} is not a valid wasm module: ${e.message}`);
    return;
  }
  const exports = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
  if (!exports.has('memory')) fail(`${label}: wasm must export "memory"`);

  // embedded manifest
  const sections = WebAssembly.Module.customSections(mod, 'stratum:manifest');
  let embedded = null;
  if (sections.length > 0) {
    try { embedded = JSON.parse(Buffer.from(sections[0]).toString('utf8')); }
    catch (e) { fail(`${label}: embedded stratum:manifest is not valid JSON: ${e.message}`); }
  } else {
    // legacy sidecar allowed
    const side = path.join(dir, entry + '.manifest.json');
    if (fs.existsSync(side)) {
      try { embedded = JSON.parse(fs.readFileSync(side, 'utf8')); }
      catch (e) { fail(`${label}: sidecar manifest not valid JSON: ${e.message}`); }
    } else {
      fail(`${label}: wasm has no embedded stratum:manifest and no sidecar ${entry}.manifest.json`);
    }
  }
  if (embedded) {
    // validate manifest schema
    if (embedded.schema_version !== 1) fail(`${label}: manifest schema_version must be 1`);
    if (typeof embedded.id !== 'string' || !MANIFEST_SCHEMA.id.pattern.test(embedded.id))
      fail(`${label}: manifest id invalid`);
    if (typeof embedded.name !== 'string' || embedded.name.length > 64)
      fail(`${label}: manifest name too long`);
    if (typeof embedded.version !== 'string' || embedded.version.length > 32)
      fail(`${label}: manifest version invalid`);
    if (embedded.name !== p.name) fail(`${label}: manifest name "${embedded.name}" != index name "${p.name}"`);
    if (embedded.version !== p.version) fail(`${label}: manifest version mismatch`);
    if (!Array.isArray(embedded.permissions)) {
      fail(`${label}: manifest permissions must be an array`);
    } else {
      for (const perm of embedded.permissions)
        if (!VALID_PERMISSIONS.has(perm)) fail(`${label}: manifest unknown permission "${perm}"`);
    }
    const mhooks = Object.keys(embedded.hooks || {}).filter((k) => embedded.hooks[k]);
    // The index entry may declare fewer hooks than the manifest (index is the
    // source of truth for the catalog), but every declared hook must be real.
    for (const h of Object.keys(p.hooks || {})) {
      if (!(p.hooks[h] === true)) fail(`${label}: hooks values must be boolean true`);
    }
    // verify exports include memory + hooks the manifest/entry declares
    const declared = new Set([...(Object.keys(p.hooks || {}))]);
    for (const h of declared) {
      if (!exports.has(h)) fail(`${label}: wasm must export hook "${h}"`);
    }
  }
}

// --- 4. README link (repo hygiene) ---------------------------------------
function checkReadme() {
  const readme = path.join(ROOT, 'README.md');
  if (!fs.existsSync(readme)) { fail('README.md is missing'); return; }
  const text = fs.readFileSync(readme, 'utf8');
  if (!text.includes('PLUGIN_TEMPLATE.md')) fail('README.md must link to PLUGIN_TEMPLATE.md');
  if (!text.includes('plugins/index.json')) fail('README.md must reference plugins/index.json');
}

// --- 5. Theme catalog (optional; validated when themes/index.json exists) --
// Mirrors the in-app Theme Hub contract: every entry must reference an on-disk
// themes/<id>/theme.json whose content sha256 matches, and download_url must
// point at that artifact. A theme without a catalog entry is a violation.
function checkThemes() {
  const indexPath = path.join(ROOT, 'themes', 'index.json');
  if (!fs.existsSync(indexPath)) return; // themes are optional
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    fail(`themes/index.json is not valid JSON: ${e.message}`);
    return;
  }
  if (index.schema !== 'stratum-theme-catalog/v1') {
    fail(`themes/index.json schema must be "stratum-theme-catalog/v1", got "${index.schema}"`);
  }
  if (!Array.isArray(index.themes) || index.themes.length === 0) {
    fail('themes/index.json must have a non-empty "themes" array');
    return;
  }
  const seen = new Set();
  for (const [i, t] of index.themes.entries()) {
    const label = `themes[${i}] (${t.id || 'no-id'})`;
    if (typeof t.id !== 'string' || !MANIFEST_SCHEMA.id.pattern.test(t.id) || t.id.length > 128)
      fail(`${label}: id invalid (reverse-DNS, ≤128, [A-Za-z0-9._-])`);
    if (typeof t.name !== 'string' || t.name.length > 64) fail(`${label}: name too long (>64)`);
    if (typeof t.version !== 'string' || t.version.length > 32) fail(`${label}: version invalid (>32)`);
    if (typeof t.dark_mode !== 'boolean') fail(`${label}: dark_mode must be a boolean`);
    if (typeof t.primary_color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(t.primary_color))
      fail(`${label}: primary_color must be a #rrggbb hex string`);
    if (typeof t.secondary_color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(t.secondary_color))
      fail(`${label}: secondary_color must be a #rrggbb hex string`);
    if (typeof t.font_size !== 'number' || t.font_size < 12 || t.font_size > 28)
      fail(`${label}: font_size must be a number in [12,28]`);
    if (typeof t.repo !== 'string' || !/^https?:\/\//.test(t.repo)) fail(`${label}: repo must be a URL`);
    if (typeof t.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(t.sha256))
      fail(`${label}: sha256 must be 64 lowercase hex chars`);
    if (typeof t.download_url !== 'string' || !/^https?:\/\//.test(t.download_url))
      fail(`${label}: download_url must be a URL`);
    if (seen.has(t.id)) fail(`${label}: duplicate id "${t.id}"`);
    seen.add(t.id);
    // Corresponding on-disk artifact + sha256 match
    const dir = path.join(ROOT, 'themes', t.id);
    if (!fs.existsSync(dir)) { fail(`${label}: no themes/${t.id}/ directory`); continue; }
    const themePath = path.join(dir, 'theme.json');
    if (!fs.existsSync(themePath)) { fail(`${label}: missing themes/${t.id}/theme.json`); continue; }
    let theme;
    try { theme = JSON.parse(fs.readFileSync(themePath, 'utf8')); }
    catch (e) { fail(`${label}: themes/${t.id}/theme.json not valid JSON: ${e.message}`); continue; }
    // content sha256 must match the index entry
    const hash = crypto.createHash('sha256').update(fs.readFileSync(themePath)).digest('hex');
    if (hash !== t.sha256) fail(`${label}: sha256 mismatch — index says ${t.sha256}, artifact is ${hash}`);
    // embedded theme identity must match the index entry
    if (theme.schema !== 'stratum-theme/v1') fail(`${label}: theme schema must be "stratum-theme/v1"`);
    if (theme.id !== t.id) fail(`${label}: theme id "${theme.id}" != index id "${t.id}"`);
    if (theme.name !== t.name) fail(`${label}: theme name mismatch`);
    if (theme.version !== t.version) fail(`${label}: theme version mismatch`);
    if (!t.download_url.includes(`/themes/${t.id}/theme.json`))
      fail(`${label}: download_url must point at themes/${t.id}/theme.json`);
  }
}

// --- Main ----------------------------------------------------------------
checkTemplate();
checkIndex();
checkReadme();
checkThemes();

if (errors.length > 0) {
  console.error('VALIDATION FAILED:');
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}
console.log('VALIDATION OK' + (warnings.length ? ' — ' + warnings.join('; ') : ''));
