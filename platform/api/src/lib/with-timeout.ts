/**
 * Resolve to `fallback` if `p` does not settle within `ms` (a rejection also
 * yields `fallback`). Health/status endpoints must report an outage, not hang
 * on it: the Mongo driver alone waits ~30 s for server selection.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([p.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}
