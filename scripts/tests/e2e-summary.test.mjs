// Unit tests for scripts/e2e/summary.mjs (job summary of an e2e VM run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from '../e2e/summary.mjs';

function dir(files) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'e2e-summary-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(d, name), content);
  return d;
}
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('passing run: phases, checks and slowest provision steps first', () => {
  const md = render(dir({
    'meta.json': JSON.stringify({ profile: 'full', ref: 'v1.4.0', sha: '0123456789abcdef', binary: 'release v1.4.0', image_tag: '1.4.0', stack: 'stable', instance_type: 't3.xlarge', market: 'spot' }),
    'phases.jsonl': jsonl([{ phase: 'launch', status: 'ok', seconds: 75 }, { phase: 'provision', status: 'ok', seconds: 301 }]),
    'results.jsonl': jsonl([{ name: 'api-health', status: 'pass', seconds: 3 }, { name: 'sso-grafana', status: 'skip', seconds: 0, reason: 'not installed' }]),
    'timings.json': JSON.stringify({ wallClockSeconds: 300, sumOfStepsSeconds: 900, steps: [{ step: 'k3s', durationSeconds: 40, status: 'ok' }, { step: 'monitoring', durationSeconds: 120, status: 'ok' }] }),
  }));
  assert.match(md, /## e2e VM: full profile passed/);
  assert.match(md, /\*\*commit:\*\* 0123456789ab/);
  assert.match(md, /t3\.xlarge \(spot\)/);
  assert.match(md, /\| provision \| pass \| 5m01s \|/);
  assert.match(md, /1 passed, 0 failed, 1 skipped/);
  assert.match(md, /sso-grafana \| skip \(not installed\)/);
  assert.ok(md.indexOf('monitoring') < md.indexOf('| k3s'), 'steps sorted by duration');
  assert.match(md, /wall clock 5m00s, sum of steps 15m00s/);
});

test('failed check or failed provision marks the run FAILED', () => {
  const failedCheck = render(dir({
    'phases.jsonl': jsonl([{ phase: 'provision', status: 'ok', seconds: 1 }]),
    'results.jsonl': jsonl([{ name: 'tenant-isolation', status: 'fail', seconds: 9 }]),
  }));
  assert.match(failedCheck, /FAILED/);
  assert.match(failedCheck, /tenant-isolation \| FAIL/);
  const failedProvision = render(dir({ 'phases.jsonl': jsonl([{ phase: 'provision', status: 'failed', seconds: 1 }]), 'timings.txt': 'step table' }));
  assert.match(failedProvision, /FAILED/);
  assert.match(failedProvision, /Checks: not run/);
  assert.match(failedProvision, /step table/);
});

test('empty artifact directory still renders', () => {
  const md = render(dir({}));
  assert.match(md, /FAILED/);
  assert.match(md, /not run/);
});

test('table cells cannot break the Markdown table', () => {
  const md = render(dir({ 'meta.json': JSON.stringify({ profile: 'a|b', image_note: 'x|y' }), 'results.jsonl': jsonl([{ name: 'n|m', status: 'pass', seconds: 1 }]) }));
  assert.match(md, /a\\\|b/);
  assert.match(md, /n\\\|m/);
});
