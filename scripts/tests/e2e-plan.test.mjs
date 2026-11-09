// Unit tests for scripts/e2e/plan.sh (what the e2e VM workflow tests and
// whether a passing run promotes a release).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../e2e/plan.sh', import.meta.url));
const configured = { ROLE_ARN: 'arn:aws:iam::000000000000:role/test', REGION: 'eu-central-1' };

function plan(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GITHUB_OUTPUT|IN_|REF_|EVENT_NAME|ROLE_ARN|REGION)/.test(k)));
  const r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...clean, ...env } });
  if (r.status !== 0) return { error: r.stderr.trim(), status: r.status };
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

test('unconfigured repositories are skipped, configured ones enabled', () => {
  assert.equal(plan({ EVENT_NAME: 'schedule', REF_TYPE: 'branch', REF_NAME: 'master' }).enabled, 'false');
  assert.equal(plan({ EVENT_NAME: 'schedule', REF_TYPE: 'branch', REF_NAME: 'master', ROLE_ARN: 'x' }).enabled, 'false');
  assert.equal(plan({ ...configured, EVENT_NAME: 'schedule', REF_TYPE: 'branch', REF_NAME: 'master' }).enabled, 'true');
});

test('nightly: both profiles, commit build, master images, edge stack, no promotion', () => {
  const p = plan({ ...configured, EVENT_NAME: 'schedule', REF_TYPE: 'branch', REF_NAME: 'master' });
  assert.deepEqual(JSON.parse(p.profiles), ['minimal', 'full']);
  assert.equal(p.mode, 'build');
  assert.equal(p.image_tag, 'master');
  assert.equal(p.image_note, '');
  assert.equal(p.stack, 'edge');
  assert.equal(p.promote, 'false');
});

test('stable tag push: release binary and images, both profiles, promotes', () => {
  const p = plan({ ...configured, EVENT_NAME: 'push', REF_TYPE: 'tag', REF_NAME: 'v1.4.0' });
  assert.deepEqual(JSON.parse(p.profiles), ['minimal', 'full']);
  assert.equal(p.mode, 'release');
  assert.equal(p.release_tag, 'v1.4.0');
  assert.equal(p.image_tag, '1.4.0');
  assert.equal(p.stack, 'stable');
  assert.equal(p.promote, 'true');
});

test('release candidates are tested but never promoted', () => {
  const p = plan({ ...configured, EVENT_NAME: 'push', REF_TYPE: 'tag', REF_NAME: 'v1.4.0-rc.2' });
  assert.equal(p.mode, 'release');
  assert.equal(p.image_tag, '1.4.0-rc.2');
  assert.equal(p.promote, 'false');
});

test('non-semver tags build from the commit and fall back to master images', () => {
  const p = plan({ ...configured, EVENT_NAME: 'push', REF_TYPE: 'tag', REF_NAME: 'vnext' });
  assert.equal(p.mode, 'build');
  assert.equal(p.image_tag, 'master');
  assert.match(p.image_note, /latest master images/);
  assert.equal(p.promote, 'false');
});

test('dispatch: minimal by default; branch refs use master images with a note', () => {
  const p = plan({ ...configured, EVENT_NAME: 'workflow_dispatch', REF_TYPE: 'branch', REF_NAME: 'issue/25' });
  assert.deepEqual(JSON.parse(p.profiles), ['minimal']);
  assert.equal(p.mode, 'build');
  assert.equal(p.image_tag, 'master');
  assert.match(p.image_note, /issue\/25/);
  assert.equal(p.promote, 'false');
  assert.deepEqual(JSON.parse(plan({ ...configured, EVENT_NAME: 'workflow_dispatch', IN_PROFILE: 'full', REF_TYPE: 'branch', REF_NAME: 'master' }).profiles), ['full']);
});

test('dispatch on a stable tag promotes only when both profiles run unmodified', () => {
  const base = { ...configured, EVENT_NAME: 'workflow_dispatch', REF_TYPE: 'tag', REF_NAME: 'v2.0.0' };
  assert.equal(plan({ ...base, IN_PROFILE: 'minimal' }).promote, 'false');
  assert.equal(plan({ ...base, IN_PROFILE: 'both' }).promote, 'true');
  assert.equal(plan({ ...base, IN_PROFILE: 'both', IN_IMAGE_TAG: 'master' }).promote, 'false');
  assert.equal(plan({ ...base, IN_PROFILE: 'both', IN_VERSION: 'v1.9.0' }).promote, 'false');
});

test('dispatch can test a published release from any branch, without promotion', () => {
  const p = plan({ ...configured, EVENT_NAME: 'workflow_dispatch', REF_TYPE: 'branch', REF_NAME: 'master', IN_VERSION: '1.3.0', IN_PROFILE: 'both' });
  assert.equal(p.mode, 'release');
  assert.equal(p.release_tag, 'v1.3.0');
  assert.equal(p.image_tag, '1.3.0');
  assert.equal(p.promote, 'false');
});

test('overrides are validated', () => {
  const base = { ...configured, EVENT_NAME: 'workflow_dispatch', REF_TYPE: 'branch', REF_NAME: 'master' };
  assert.equal(plan({ ...base, IN_IMAGE_TAG: '1.2.3' }).image_tag, '1.2.3');
  assert.equal(plan({ ...base, IN_STACK: '2026.11.08-4' }).stack, '2026.11.08-4');
  for (const bad of [{ IN_PROFILE: 'ha' }, { IN_VERSION: 'latest' }, { IN_IMAGE_TAG: 'a b' }, { IN_IMAGE_TAG: '$(id)' }, { IN_STACK: '../x' }]) {
    assert.ok(plan({ ...base, ...bad }).error, JSON.stringify(bad));
  }
  assert.ok(plan({ ...configured, EVENT_NAME: 'pull_request' }).error);
});
