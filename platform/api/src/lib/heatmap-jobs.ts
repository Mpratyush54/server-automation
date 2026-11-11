import { getDb } from '../config/database';
import { registerLeaderJob } from './scheduler';
import { HEATMAP_RETENTION_JOB, pruneHeatmaps } from './heatmaps';

/** Leader-only hourly prune of heatmap aggregates past each project's #47 `heatmaps` retention. */
export function startHeatmapRetention(): void {
  registerLeaderJob({
    name: HEATMAP_RETENTION_JOB,
    intervalMs: 60 * 60 * 1000,
    initialDelayMs: 15 * 60 * 1000,
    run: async () => {
      const deleted = await pruneHeatmaps(await getDb());
      const total = Object.values(deleted).reduce((a, n) => a + n, 0);
      if (total) console.log(`[heatmaps] retention pruned ${total} rows ${JSON.stringify(deleted)}`);
    },
  });
}
