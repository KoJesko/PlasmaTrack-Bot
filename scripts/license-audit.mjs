// Fails if any installed package (direct or transitive, any workspace) has a
// license outside the FOSS allowlist below. Run: npm run license-audit
//
// Adding a license to ALLOWED, or a package to REVIEWED or APPROVED_PACKAGES, needs the project
// owner's OK (rule: every dependency must be FOSS; ask before anything else).

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'MPL-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Zlib',
  'Python-2.0',
  // Bundled libvips in sharp's prebuilt binaries (approved 2026-09-28).
  'LGPL-3.0-or-later',
]);

// Packages whose package.json has no usable SPDX field, checked by hand.
// name -> the license found in the package's own files.
const REVIEWED = {};

// Free licenses accepted for one named package only, not added to ALLOWED.
// name -> the exact license string accepted. A different license on that
// package (e.g. after an upgrade) fails the audit again.
const APPROVED_PACKAGES = {
  // Data file (list of SPDX exception IDs), pulled in by
  // @maplibre/maplibre-gl-native → npm-run-all → read-pkg; not loaded by
  // PlasmaTrack code. Approved by the project owner 2026-10-13.
  'spdx-exceptions': 'CC-BY-3.0',
};

const root = join(import.meta.dirname, '..');
const seen = new Map(); // "name@version" -> license
const problems = [];

function readLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return null;
}

/** Minimal SPDX expression check: OR = any branch allowed, AND/WITH = all parts allowed. */
function isAllowed(expr) {
  const e = expr.trim().replace(/^\((.*)\)$/, '$1').trim();
  if (/\sOR\s/.test(e) && !/\(/.test(e)) return e.split(/\s+OR\s+/).some(isAllowed);
  if (/\sAND\s/.test(e) && !/\(/.test(e)) return e.split(/\s+AND\s+/).every(isAllowed);
  if (/\(/.test(e)) {
    // Split at the top level only.
    let depth = 0;
    const parts = [];
    let op = null;
    let cur = '';
    for (const tok of e.split(/(\(|\)|\s+OR\s+|\s+AND\s+)/)) {
      if (tok === '(') depth++;
      if (tok === ')') depth--;
      const m = depth === 0 && /^\s+(OR|AND)\s+$/.exec(tok);
      if (m) {
        parts.push(cur);
        cur = '';
        op = m[1];
      } else cur += tok;
    }
    parts.push(cur);
    if (parts.length === 1) return isAllowed(parts[0].replace(/^\((.*)\)$/, '$1'));
    return op === 'OR' ? parts.some(isAllowed) : parts.every(isAllowed);
  }
  return ALLOWED.has(e);
}

function walk(nodeModules) {
  if (!existsSync(nodeModules)) return;
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    const dir = join(nodeModules, entry);
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(dir)) visit(join(dir, scoped));
    } else visit(dir);
  }
}

function visit(dir) {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest) || !statSync(dir).isDirectory()) return;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!pkg.name || pkg.name.startsWith('@plasmatrack/')) return;
  const id = `${pkg.name}@${pkg.version}`;
  if (!seen.has(id)) {
    const license = readLicense(pkg) ?? REVIEWED[pkg.name] ?? null;
    seen.set(id, license);
    if (!license) problems.push(`${id}: no license field`);
    else if (!isAllowed(license) && APPROVED_PACKAGES[pkg.name] !== license) problems.push(`${id}: ${license}`);
  }
  walk(join(dir, 'node_modules'));
}

walk(join(root, 'node_modules'));
for (const ws of ['core', 'worker', 'renderer']) walk(join(root, 'packages', ws, 'node_modules'));

const counts = {};
for (const l of seen.values()) counts[l ?? '(none)'] = (counts[l ?? '(none)'] ?? 0) + 1;
console.log(`license audit: ${seen.size} packages`);
for (const [l, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${l}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} package(s) need review:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll licenses are on the FOSS allowlist or individually approved.');
