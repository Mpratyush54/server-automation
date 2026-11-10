/** Growth of the currently accessible active project count since seven days ago.
 * Hide the comparison when there was no baseline (or dates are incomplete).
 */
export function projectGrowth(projects: { createdAt?: string }[], now = Date.now()): number | null {
  const dates = projects.map(p => p.createdAt ? Date.parse(p.createdAt) : NaN);
  if (dates.some(t => !Number.isFinite(t) || t > now)) return null;
  const previous = dates.filter(t => t <= now - 7 * 86400_000).length;
  return previous ? Math.round((projects.length - previous) / previous * 100) : null;
}

/** Mean elapsed time from creation to successful completion, across all returned
 * deployments. A completion timestamp also preserves samples later rolled back,
 * terminated or expired. Failed/in-flight records and invalid dates are excluded.
 */
export function averageDeployTime(deployments: { status: string; createdAt?: string; deployedAt?: string | null }[]): string {
  const completed = new Set(['deployed', 'rolled_back', 'terminated', 'expired', 'active', 'success']);
  const durations = deployments.filter(d => completed.has(d.status)).map(d => {
    if (!d.createdAt || !d.deployedAt) return NaN;
    return Date.parse(d.deployedAt) - Date.parse(d.createdAt);
  }).filter(ms => Number.isFinite(ms) && ms >= 0);
  if (!durations.length) return '—';
  const seconds = Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
