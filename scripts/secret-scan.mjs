#!/usr/bin/env node
// Fails if a tracked file looks like it holds a credential. Cheap guard for
// `npm run check` and CI; it does not replace keeping secrets out of the repo.
//
// Usage: node scripts/secret-scan.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  // Discord bot token: base64 user ID . timestamp . HMAC
  { name: 'Discord bot token', re: /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/ },
  // PlasmaTrack player/service tokens; the server's examples use an obvious placeholder.
  { name: 'PlasmaTrack token', re: /\bpt_(live|test|bot|read)_(?!EXAMPLE-ONLY)[A-Za-z0-9_-]{16,}/ },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: 'Cloudflare API token assignment', re: /CLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{30,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  // Assignments of secret-named keys to long literal values (e.g. in a committed .dev.vars).
  {
    name: 'secret assignment',
    re: /^\s*(?:DISCORD_BOT_TOKEN|RENDERER_KEY|PLASMATRACK_(?:BOT_TOKEN|WEBHOOK_SECRET)\w*)\s*=\s*["']?(?!<|your|change|xxx|\.\.\.)[^\s"'#]{16,}/m,
  },
];

// Known fake values in docs and tests (exact strings). Add here only after checking.
const ALLOWED = new Set([
  'pt_live_3uJ8sX0mQ2vR7kLp9wZc4bNf6tYh1aEd', // server contract doc example (PUBLIC_API §1)
  'pt_bot_test_token_not_a_secret_000001', // demo backend / mock API
  'pt_read_test_token_not_a_secret_00001', // demo backend / mock API
  'pt_bot_0123456789abcdef', // config tests
  'pt_live_0123456789abcdef0123456789abcdef', // log redaction tests
]);

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const BINARY = /\.(png|jpe?g|webp|gif|pmtiles|pbf|ttf|otf|woff2?|ico|zip|gz)$/i;

const findings = [];
for (const file of files) {
  if (BINARY.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  for (const { name, re } of PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(global)) {
      if (ALLOWED.has(m[0])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push(`${file}:${line}: ${name}`);
      break;
    }
  }
}

if (findings.length > 0) {
  console.error('Possible secrets in tracked files (values not shown):');
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`secret scan: ${files.length} tracked files, nothing found`);
