// Render the e2e job summary (Markdown) from the files in E2E_ARTIFACTS:
// meta.json, phases.jsonl, results.jsonl, timings.json (platformctl) or
// timings.txt. Appends to $GITHUB_STEP_SUMMARY when set and always writes
// E2E_ARTIFACTS/summary.md. Unit-tested by scripts/tests/e2e-summary.test.mjs.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const readJSON = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const readLines = (f) => {
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
};
const dur = (s) => {
  const n = Math.round(Number(s) || 0);
  return `${Math.floor(n / 60)}m${String(n % 60).padStart(2, '0')}s`;
};
const icon = { pass: 'pass', ok: 'pass', fail: 'FAIL', failed: 'FAIL', skip: 'skip', skipped: 'skip', cached: 'cached' };
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function render(dir) {
  const meta = readJSON(path.join(dir, 'meta.json')) || {};
  const phases = readLines(path.join(dir, 'phases.jsonl'));
  const results = readLines(path.join(dir, 'results.jsonl'));
  const timings = readJSON(path.join(dir, 'timings.json'));
  const failed = results.filter((r) => r.status === 'fail');
  const provision = phases.find((p) => p.phase === 'provision');
  const verdict = failed.length === 0 && !phases.some((p) => p.status === 'failed') && results.length > 0 && provision?.status === 'ok' ? 'passed' : 'FAILED';
  const out = [];
  out.push(`## e2e VM: ${cell(meta.profile || '?')} profile ${verdict}`, '');
  const facts = [
    ['ref', meta.ref], ['commit', meta.sha && String(meta.sha).slice(0, 12)], ['platformctl', meta.binary],
    ['images', meta.image_tag], ['stack', meta.stack], ['instance', meta.instance_type && `${meta.instance_type} (${meta.market || '?'})`],
  ].filter(([, v]) => v);
  if (facts.length) out.push(facts.map(([k, v]) => `**${k}:** ${cell(v)}`).join(' · '), '');
  if (meta.image_note) out.push(`> Note: ${cell(meta.image_note)}`, '');
  if (phases.length) {
    out.push('| phase | status | duration |', '|---|---|---|');
    for (const p of phases) out.push(`| ${cell(p.phase)} | ${icon[p.status] || cell(p.status)} | ${dur(p.seconds)} |`);
    out.push('');
  }
  if (results.length) {
    const pass = results.filter((r) => r.status === 'pass').length;
    const skip = results.filter((r) => r.status === 'skip').length;
    out.push(`### Checks: ${pass} passed, ${failed.length} failed, ${skip} skipped`, '', '| check | result | duration |', '|---|---|---|');
    for (const r of results) out.push(`| ${cell(r.name)} | ${icon[r.status] || cell(r.status)}${r.reason ? ` (${cell(r.reason)})` : ''} | ${dur(r.seconds)} |`);
    out.push('');
  } else {
    out.push('### Checks: not run', '');
  }
  if (timings?.steps?.length) {
    out.push(`### Provision step timings (wall clock ${dur(timings.wallClockSeconds)}, sum of steps ${dur(timings.sumOfStepsSeconds)})`, '');
    out.push('<details><summary>steps</summary>', '', '| step | duration | status |', '|---|---|---|');
    for (const s of [...timings.steps].sort((a, b) => b.durationSeconds - a.durationSeconds)) {
      out.push(`| ${cell(s.step)} | ${dur(s.durationSeconds)} | ${icon[s.status] || cell(s.status)} |`);
    }
    out.push('', '</details>', '');
  } else if (existsSync(path.join(dir, 'timings.txt'))) {
    out.push('### Provision step timings', '', '```', readFileSync(path.join(dir, 'timings.txt'), 'utf8').trim(), '```', '');
  }
  out.push('Logs, timings, pod logs and events (redacted) are in the run artifact.', '');
  return out.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.env.E2E_ARTIFACTS || process.argv[2];
  if (!dir) { console.error('usage: E2E_ARTIFACTS=<dir> node summary.mjs'); process.exit(2); }
  const md = render(dir);
  writeFileSync(path.join(dir, 'summary.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  else process.stdout.write(md);
}
