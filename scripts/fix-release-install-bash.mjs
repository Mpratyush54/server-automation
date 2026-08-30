#!/usr/bin/env node
/**
 * Rewrite published GitHub release notes: install.sh | sh -> install.sh | bash
 *
 * Usage:
 *   node scripts/fix-release-install-bash.mjs          # all releases
 *   node scripts/fix-release-install-bash.mjs v1.0.0   # one tag
 *
 * Requires: gh CLI authenticated for Mpratyush54/server-automation
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FROM = /install\.sh \| sh/g;
const TO = 'install.sh | bash';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function listTags() {
  const json = gh(['release', 'list', '--limit', '100', '--json', 'tagName']);
  return JSON.parse(json).map((r) => r.tagName);
}

function releaseBody(tag) {
  return gh(['release', 'view', tag, '--json', 'body', '-q', '.body']);
}

function editRelease(tag, body) {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  const file = join(dir, `${tag}.md`);
  try {
    writeFileSync(file, body, 'utf8');
    gh(['release', 'edit', tag, '--notes-file', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tags = process.argv.slice(2).length ? process.argv.slice(2) : listTags();
let updated = 0;

for (const tag of tags) {
  const body = releaseBody(tag);
  if (!body.includes('install.sh | sh')) {
    console.log(`skip ${tag}: no install.sh | sh`);
    continue;
  }
  const next = body.replace(FROM, TO);
  editRelease(tag, next);
  console.log(`updated ${tag}`);
  updated += 1;
}

console.log(`done: ${updated} release(s) updated`);
