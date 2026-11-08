import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { AppDataSource } from '../config/database';
import { Project } from '../entities/Project';
import { reportNamespaceBaseline, applyNamespaceBackfill, backfillFingerprint, validateBackfillReport } from '../lib/namespace-backfill';

/** One-shot operator job. Dry-run is the default and is required before --apply. */
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const enforce = args.includes('--enforce');
  if (args.some(a => !['--apply', '--enforce', '--report'].includes(a) && args[args.indexOf(a) - 1] !== '--report')) throw new Error('Unknown argument');
  const reportPath = args[args.indexOf('--report') + 1];
  if (!args.includes('--report') || !reportPath || reportPath.startsWith('--')) throw new Error('--report <path> required');
  if (enforce && !apply) throw new Error('--enforce requires --apply after reviewing warn-mode workloads');
  // Do not let this administrative job synchronize the database schema.
  AppDataSource.setOptions({ synchronize: false });
  await AppDataSource.initialize();
  try {
    const projects = await AppDataSource.getRepository(Project).find({ where: { isActive: true }, relations: ['environments'] });
    const rows: any[] = [];
    for (const project of projects) for (const env of project.environments || []) {
      if (!env.isActive) continue;
      if (env.namespace === 'preview') { rows.push({ projectId: project.id, namespace: env.namespace, skipped: 'Shared legacy preview: redeploy into dedicated preview namespace and retire old workloads manually' }); continue; }
      try { rows.push(await reportNamespaceBaseline(project.id, env)); }
      catch (e: any) { rows.push({ projectId: project.id, environment: env.name, namespace: env.namespace, ...(e.code === 404 ? { skipped: 'Namespace not created yet; baseline will apply on first deployment' } : { error: e.message }) }); }
    }
    const fingerprint = backfillFingerprint(rows);
    if (!apply) {
      writeFileSync(reportPath, JSON.stringify({ fingerprint, rows }, null, 2), { mode: 0o600 });
      console.log(`Dry-run report written: ${rows.length} environments. No Kubernetes writes.`);
      return;
    }
    const reviewed = JSON.parse(readFileSync(reportPath, 'utf8'));
    validateBackfillReport(rows, reviewed, enforce);
    for (const row of rows) {
      if (row.skipped) { console.log(`Skipped ${row.namespace}: ${row.skipped}`); continue; }
      await applyNamespaceBackfill(row.projectId, { name: row.environment, namespace: row.namespace }, enforce);
      console.log(`Applied ${row.namespace}: ${enforce ? 'restricted enforcement' : 'restricted warn/audit, existing enforcement preserved'}`);
    }
  } finally { await AppDataSource.destroy(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
