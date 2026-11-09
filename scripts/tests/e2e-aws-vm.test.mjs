// Executes scripts/e2e/aws-vm.sh against fake aws/curl/ssh commands to check
// the quoting of every JSON argument, the tags the IAM policy relies on, the
// spot fallback, teardown and the janitor's age logic. No AWS access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../e2e/aws-vm.sh', import.meta.url));
const posix = (p) => p.replace(/\\/g, '/');

const FAKE_AWS = String.raw`#!/usr/bin/env bash
# Records each call as NUL-separated args, calls separated by RS (octal 036).
{ printf '%s\0' "$@"; printf '\036'; } >> "$FAKE_LOG"
all="$*"
case "$all" in
  "ssm get-parameter"*) echo ami-0123456789abcdef0 ;;
  "ec2 describe-vpcs"*) echo vpc-0123abcd ;;
  "ec2 create-security-group"*) echo sg-0123abcd ;;
  "ec2 authorize-security-group-ingress"*) echo '{}' ;;
  "ec2 run-instances"*)
    if [[ "$all" == *spot* && "\${FAKE_SPOT_FAIL:-0}" == 1 ]]; then
      echo "An error occurred (InsufficientInstanceCapacity) when calling the RunInstances operation" >&2; exit 254
    fi
    echo i-0123456789abcdef0 ;;
  "ec2 wait"*) ;;
  *"PublicIpAddress"*) echo 203.0.113.9 ;;
  *"LaunchTime"*) printf '%s\t%s\t%s\n' i-0old000000000001 2020-01-01T00:00:00+00:00 None i-0new000000000002 "$FAKE_NOW" "$FAKE_LATER" ;;
  "ec2 describe-instances"*) echo "" ;;
  *"created-at"*) printf '%s\t%s\n' sg-0old0001 2020-01-01T00:00:00Z sg-0new0002 "$FAKE_NOW" sg-0untagged None ;;
  "ec2 describe-security-groups"*) echo "" ;;
  "ec2 terminate-instances"*|"ec2 delete-security-group"*) echo '{}' ;;
  *) echo "unexpected aws call: $all" >&2; exit 1 ;;
esac
`;

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-awsvm-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const write = (name, body) => { writeFileSync(path.join(bin, name), body.replace(/\\\$\{/g, '${')); chmodSync(path.join(bin, name), 0o755); };
  write('aws', FAKE_AWS);
  write('curl', '#!/usr/bin/env bash\necho 203.0.113.50\n');
  write('ssh', '#!/usr/bin/env bash\nexit 0\n');
  return { dir, bin, work: path.join(dir, 'work'), log: path.join(dir, 'aws.log') };
}

function run(ctx, cmd, extra = {}) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const later = new Date(Date.now() + 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  return spawnSync('bash', ['-c', 'PATH="$(cd "$1" && pwd):$PATH"; exec bash "$2" "$3"', '_', posix(ctx.bin), posix(script), cmd], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', AWS_REGION: 'eu-central-1', E2E_WORK: posix(ctx.work), E2E_ARTIFACTS: posix(path.join(ctx.dir, 'artifacts')), E2E_RUN_ID: '123-1', E2E_PROFILE: 'minimal', FAKE_LOG: posix(ctx.log), FAKE_NOW: now, FAKE_LATER: later, ...extra },
  });
}

function calls(ctx) {
  return readFileSync(ctx.log, 'utf8').split('\x1e').filter(Boolean).map((l) => l.split('\0').filter((x) => x !== ''));
}
const arg = (call, flag) => call[call.indexOf(flag) + 1];

test('launch: valid JSON arguments, required tags, SSH only from the runner, state recorded', () => {
  const ctx = setup();
  let r = run(ctx, 'keys');
  assert.equal(r.status, 0, r.stderr);
  r = run(ctx, 'launch');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const all = calls(ctx);
  const sg = all.find((c) => c[1] === 'create-security-group');
  const sgTags = JSON.parse(arg(sg, '--tag-specifications'));
  assert.equal(sgTags[0].ResourceType, 'security-group');
  const tags = Object.fromEntries(sgTags[0].Tags.map((t) => [t.Key, t.Value]));
  assert.equal(tags.purpose, 'platform-e2e-ci');
  assert.equal(tags['run-id'], '123-1');
  assert.equal(tags.profile, 'minimal');
  assert.ok(Date.parse(tags['expires-at']) - Date.parse(tags['created-at']) === 150 * 60e3, 'TTL is 150 minutes');

  const perms = JSON.parse(arg(all.find((c) => c[1] === 'authorize-security-group-ingress'), '--ip-permissions'));
  const byPort = Object.fromEntries(perms.map((p) => [p.FromPort, p.IpRanges.map((x) => x.CidrIp)]));
  assert.deepEqual(byPort, { 22: ['203.0.113.50/32'], 80: ['0.0.0.0/0'], 443: ['0.0.0.0/0'] });

  const runInst = all.find((c) => c[1] === 'run-instances');
  assert.equal(arg(runInst, '--instance-type'), 't3.xlarge');
  assert.equal(arg(runInst, '--instance-initiated-shutdown-behavior'), 'terminate');
  assert.equal(JSON.parse(arg(runInst, '--block-device-mappings'))[0].Ebs.VolumeSize, 100);
  const specs = JSON.parse(arg(runInst, '--tag-specifications'));
  assert.deepEqual(specs.map((s) => s.ResourceType), ['instance', 'volume']);
  assert.ok(specs.every((s) => s.Tags.some((t) => t.Key === 'purpose' && t.Value === 'platform-e2e-ci')));
  assert.equal(JSON.parse(arg(runInst, '--instance-market-options')).MarketType, 'spot');
  assert.match(arg(runInst, '--metadata-options'), /HttpTokens=required/);

  const state = readFileSync(path.join(ctx.work, 'state.env'), 'utf8');
  for (const want of ['SG_ID=sg-0123abcd', 'INSTANCE_ID=i-0123456789abcdef0', 'MARKET=spot', 'VM_IP=203.0.113.9', 'DOMAIN=203.0.113.9.sslip.io']) assert.match(state, new RegExp(`^${want}$`, 'm'));

  const userData = readFileSync(path.join(ctx.work, 'user-data.yaml'), 'utf8');
  const hostPub = readFileSync(path.join(ctx.work, 'host_ed25519.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  const clientPub = readFileSync(path.join(ctx.work, 'id_ed25519.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  assert.ok(userData.startsWith('#cloud-config\n'));
  assert.ok(userData.includes(`ed25519_public: ${hostPub}`));
  assert.ok(userData.includes(`  - ${clientPub}`));
  assert.match(userData, /-----BEGIN OPENSSH PRIVATE KEY-----/);
  assert.match(userData, /shutdown, -P, "\+150"/);
  assert.match(readFileSync(path.join(ctx.work, 'known_hosts'), 'utf8'), /^platform-e2e-vm ssh-ed25519 /);
});

test('launch falls back to on-demand when spot capacity is unavailable', () => {
  const ctx = setup();
  run(ctx, 'keys');
  const r = run(ctx, 'launch', { FAKE_SPOT_FAIL: '1' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const runs = calls(ctx).filter((c) => c[1] === 'run-instances');
  assert.equal(runs.length, 2);
  assert.ok(runs[0].includes('--instance-market-options'));
  assert.ok(!runs[1].includes('--instance-market-options'));
  assert.match(readFileSync(path.join(ctx.work, 'state.env'), 'utf8'), /^MARKET=on-demand$/m);
  assert.match(r.stdout, /falling back to on-demand/);
});

test('teardown terminates the recorded instance and deletes its security group', () => {
  const ctx = setup();
  run(ctx, 'keys');
  run(ctx, 'launch');
  writeFileSync(ctx.log, '');
  const r = run(ctx, 'teardown');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const all = calls(ctx);
  const term = all.find((c) => c[1] === 'terminate-instances');
  assert.ok(term.includes('i-0123456789abcdef0'));
  const del = all.find((c) => c[1] === 'delete-security-group');
  assert.equal(arg(del, '--group-id'), 'sg-0123abcd');
  const filters = all.find((c) => c[1] === 'describe-instances');
  for (const f of ['Name=tag:purpose,Values=platform-e2e-ci', 'Name=tag:run-id,Values=123-1', 'Name=tag:profile,Values=minimal']) assert.ok(filters.includes(f), f);
});

test('janitor removes only expired resources; dry-run removes nothing', () => {
  const ctx = setup();
  let r = run(ctx, 'janitor');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  let all = calls(ctx);
  const terminated = all.filter((c) => c[1] === 'terminate-instances').flatMap((c) => c.slice(2));
  assert.ok(terminated.includes('i-0old000000000001'));
  assert.ok(!terminated.includes('i-0new000000000002'));
  const deleted = all.filter((c) => c[1] === 'delete-security-group').map((c) => arg(c, '--group-id'));
  assert.deepEqual(deleted.sort(), ['sg-0old0001', 'sg-0untagged']);

  writeFileSync(ctx.log, '');
  r = run(ctx, 'janitor', { E2E_DRY_RUN: 'true' });
  assert.equal(r.status, 0);
  all = calls(ctx);
  assert.ok(!all.some((c) => c[1] === 'terminate-instances' || c[1] === 'delete-security-group'));
  assert.match(r.stdout, /terminate i-0old000000000001/);
});
