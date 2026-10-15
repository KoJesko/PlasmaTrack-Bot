#!/usr/bin/env node
// Copies the server's bot-facing contract into this repo, from one commit of
// the server repository:
//   docs/{API_CONVENTIONS,PUBLIC_API,ADMIN_API,WEBHOOKS}.md → docs/contract/
//   docs/examples/*.json → packages/core/test/fixtures/server-examples/
// The examples are real server responses; contract-examples.test.ts parses
// every one with the bot's schemas, so a breaking server change fails the tests.
//
// Usage: node scripts/sync-contract.mjs <server-repo-path> <commit>

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [repo, commit] = process.argv.slice(2);
if (!repo || !commit || !/^[0-9a-f]{7,40}$/i.test(commit)) {
  console.error('usage: node scripts/sync-contract.mjs <server-repo-path> <commit>');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const full = git('rev-parse', '--verify', `${commit}^{commit}`).trim();
const short = full.slice(0, 7);

for (const name of ['API_CONVENTIONS', 'PUBLIC_API', 'ADMIN_API', 'WEBHOOKS']) {
  writeFileSync(join(root, 'docs/contract', `${name}.md`), git('show', `${full}:docs/${name}.md`));
}

const examplesDir = join(root, 'packages/core/test/fixtures/server-examples');
rmSync(examplesDir, { recursive: true, force: true });
mkdirSync(examplesDir, { recursive: true });
const files = git('ls-tree', '--name-only', full, 'docs/examples/')
  .split('\n')
  .filter((f) => f.endsWith('.json'));
for (const f of files) writeFileSync(join(examplesDir, f.slice('docs/examples/'.length)), git('show', `${full}:${f}`));
writeFileSync(join(examplesDir, 'SOURCE'), `${full}\n`);

console.log(`contract and ${readdirSync(examplesDir).length - 1} examples copied from ${short}`);
console.log('Update the commit named in docs/contract/README.md, then run npm run check.');
