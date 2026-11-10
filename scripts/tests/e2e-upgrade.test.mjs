import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSource } from '../e2e/upgrade-plan.mjs';

test('previous release includes rc, excludes target, drafts, invalid tags and newer releases', () => {
  const releases = ['v1.3.0-rc.2', 'v1.2.0', 'v1.3.0-rc.10', 'v1.3.0', 'v2.0.0', 'vnext'].map((tag_name) => ({ tag_name }));
  releases.push({ tag_name: 'v1.3.0-rc.11', draft: true });
  assert.equal(selectSource(releases, 'v1.3.0'), 'v1.3.0-rc.10');
  assert.equal(selectSource(releases, 'v1.3.0-rc.10'), 'v1.3.0-rc.2');
  assert.equal(selectSource(releases, 'v1.2.0'), '');
  assert.equal(selectSource(releases, 'v1.3.0', 'v1.2.0'), 'v1.2.0');
  for (const from of ['v1.3.0', 'v2.0.0', 'latest', 'v1.2.0;id']) {
    assert.throws(() => selectSource(releases, 'v1.3.0', from));
  }
});

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  const put = (name, body) => { const f = path.join(bin, name); writeFileSync(f, body); chmodSync(f, 0o755); };
  const posix = (s) => s.replace(/\\/g, '/');
  const run = (command, env = {}) => spawnSync('bash', ['-c', 'PATH="$(cd "$1" && pwd):$PATH"; shift; "$@"', '_', posix(bin), ...command.map(posix)], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: posix(path.join(dir, 'output')), GITHUB_STEP_SUMMARY: '', GITHUB_REPOSITORY: 'example/platform', E2E_WORK: posix(path.join(dir, 'work')), ...env },
  });
  return { dir, put, run };
}
const script = (name) => fileURLToPath(new URL(`../e2e/${name}`, import.meta.url));

test('planner uses paginated releases API, including pre-releases on later pages', (t) => {
  const f = fixture(t);
  f.put('gh', `#!/usr/bin/env bash
[[ "$*" == 'api --paginate --slurp repos/example/platform/releases?per_page=100' ]] || exit 9
echo '[[{"tag_name":"v1.3.0"}],[{"tag_name":"v1.3.0-rc.4","prerelease":true},{"tag_name":"v1.2.0"}]]'
`);
  const r = f.run(['node', script('upgrade-plan.mjs')], { UPGRADE_TO: 'v1.3.0', IN_UPGRADE_FROM: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(f.dir, 'output'), 'utf8'), 'upgrade_from=v1.3.0-rc.4\n');
});

test('missing upgrade command skips; supported source runs; download and checksum failures fail', (t) => {
  const f = fixture(t);
  // Fake downloads produce a real archive and checksum entirely in the temp dir.
  f.put('gh', `#!/usr/bin/env bash
[[ "$FAKE_FAIL" != download ]] || exit 7
while [[ $# -gt 0 ]]; do if [[ "$1" == -D ]]; then dest=$2; shift; fi; shift; done
cd "$dest"
printf '#!/usr/bin/env bash\\nprintf "Commands:\\\\n  %s test command\\\\n"\\n' "$FAKE_COMMAND" > platformctl
tar -czf platformctl_1.2.0_linux_amd64.tar.gz platformctl
sha256sum platformctl_1.2.0_linux_amd64.tar.gz > checksums.txt
if [[ "$FAKE_FAIL" == checksum ]]; then echo bad > checksums.txt; fi
`);
  for (const [command, fail, expected] of [['provision', '', 'false'], ['upgrade', '', 'true'], ['upgrade', 'download', null], ['upgrade', 'checksum', null]]) {
    rmSync(path.join(f.dir, 'output'), { force: true });
    const r = f.run(['bash', script('upgrade-source.sh')], { UPGRADE_FROM: 'v1.2.0', FAKE_COMMAND: command, FAKE_FAIL: fail });
    if (expected === null) assert.notEqual(r.status, 0);
    else {
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(readFileSync(path.join(f.dir, 'output'), 'utf8'), `supported=${expected}\n`);
      if (expected === 'false') assert.match(r.stdout, /predates platformctl upgrade/);
    }
  }
});
