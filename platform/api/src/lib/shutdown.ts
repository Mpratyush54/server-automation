import type { Server } from 'http';
import type { Request, Response, NextFunction } from 'express';

/**
 * Graceful shutdown for rolling deploys and node drains.
 *
 * On SIGTERM (sent after the pod's preStop sleep, by which time the endpoint has been removed
 * from the Service): mark the process as draining (readiness → 503, responses carry
 * `Connection: close`), stop accepting connections, let in-flight requests finish, then close
 * DB/Redis/Mongo and exit. A hard deadline force-closes lingering sockets so the process exits
 * inside terminationGracePeriodSeconds.
 */

let draining = false;

export function isShuttingDown(): boolean {
  return draining;
}

/** Tests only. */
export function resetShutdownStateForTests(): void {
  draining = false;
}

/** While draining, ask keep-alive clients to reconnect (they will reach another replica). */
export function drainingConnectionClose(_req: Request, res: Response, next: NextFunction): void {
  if (draining) res.setHeader('Connection', 'close');
  next();
}

export interface ShutdownOptions {
  /** Force-close sockets and continue after this long. Default SHUTDOWN_TIMEOUT_MS or 25 s. */
  timeoutMs?: number;
  /**
   * Run first, before draining, and awaited (each bounded by `preDrainTimeoutMs`).
   * Used to hand over leadership at once: releasing the leader Lease must finish
   * before the process exits, or peers wait for it to expire (~lease duration).
   */
  preDrain?: Array<{ name: string; run: () => Promise<unknown> | unknown }>;
  /** Per-step bound for `preDrain`. Default 3 s. */
  preDrainTimeoutMs?: number;
  /** Resources to release after the HTTP server has stopped (DB, Redis, ...). Errors are logged. */
  closers?: Array<{ name: string; close: () => Promise<unknown> | unknown }>;
  /** Called with the exit code at the end. Default process.exit. */
  exit?: (code: number) => void;
  log?: (msg: string) => void;
}

/** Drain `server` and release resources. Resolves when done (then calls `exit`). */
export async function gracefulShutdown(server: Server, opts: ShutdownOptions = {}): Promise<void> {
  const log = opts.log || ((m: string) => console.log(m));
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.SHUTDOWN_TIMEOUT_MS) || 25_000);
  draining = true;

  const preDrainTimeoutMs = opts.preDrainTimeoutMs ?? 3_000;
  for (const step of opts.preDrain || []) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), preDrainTimeoutMs); });
      const result = await Promise.race([Promise.resolve().then(step.run).then(() => 'done' as const), timedOut]);
      log(result === 'done' ? `[server] shutdown: ${step.name}` : `[server] shutdown: ${step.name} timed out`);
    } catch (err: any) {
      log(`[server] shutdown: ${step.name} failed: ${err?.message || err}`);
    } finally {
      clearTimeout(timer);
    }
  }
  log('[server] shutdown: draining in-flight requests');

  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      log('[server] shutdown: deadline reached, closing remaining connections');
      (server as any).closeAllConnections?.();
      resolve();
    }, timeoutMs);
    force.unref?.();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    // Idle keep-alive sockets would otherwise hold close() open until they time out.
    (server as any).closeIdleConnections?.();
  });

  for (const c of opts.closers || []) {
    try {
      await c.close();
      log(`[server] shutdown: closed ${c.name}`);
    } catch (err: any) {
      log(`[server] shutdown: closing ${c.name} failed: ${err?.message || err}`);
    }
  }
  log('[server] shutdown complete');
  (opts.exit || ((code: number) => process.exit(code)))(0);
}

/** Wire SIGTERM/SIGINT to {@link gracefulShutdown}; a second signal is ignored while draining. */
export function installGracefulShutdown(server: Server, opts: ShutdownOptions = {}): void {
  let started = false;
  const handler = (signal: string) => {
    if (started) return;
    started = true;
    console.log(`[server] ${signal} received`);
    void gracefulShutdown(server, opts);
  };
  process.once('SIGTERM', () => handler('SIGTERM'));
  process.once('SIGINT', () => handler('SIGINT'));
}
