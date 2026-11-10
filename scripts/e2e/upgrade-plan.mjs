// Select the highest published version below the target, including rc releases.
// gh paginates the releases API; /latest would omit pre-releases.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function version(tag) {
  const m = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);
  if (!m || m[4]?.split('.').some((p) => /^0\d+$/.test(p))) throw new Error('release tag must look like v1.2.3 or v1.2.3-rc.1');
  return [BigInt(m[1]), BigInt(m[2]), BigInt(m[3]), m[4]?.split('.')];
}
export function compare(a, b) {
  const x = version(a), y = version(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  if (!x[3] || !y[3]) return x[3] ? -1 : y[3] ? 1 : 0;
  for (let i = 0; i < Math.max(x[3].length, y[3].length); i++) {
    const p = x[3][i], q = y[3][i];
    if (p === q) continue;
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}
export function selectSource(releases, target, explicit = '') {
  version(target);
  if (explicit) {
    version(explicit);
    if (compare(explicit, target) >= 0) throw new Error('upgrade_from must precede the target release');
    return explicit;
  }
  return releases.filter((r) => {
    if (r.draft) return false;
    try { return compare(r.tag_name, target) < 0; } catch { return false; }
  }).map((r) => r.tag_name).sort(compare).at(-1) || '';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const target = process.env.UPGRADE_TO;
    version(target);
    const explicit = process.env.IN_UPGRADE_FROM || '';
    const releases = explicit ? [] : JSON.parse(execFileSync('bash', ['-c', 'exec gh "$@"', '_', 'api', '--paginate', '--slurp',
      `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`], { encoding: 'utf8' })).flat();
    const source = selectSource(releases, target, explicit);
    const output = `upgrade_from=${source}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
    if (!source) console.log('::notice title=Upgrade skipped::No published release precedes the target.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
