import express, { NextFunction, Request, Response } from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { markInternalMcpRequest } from './mcp-internal';

/**
 * Loopback-only HTTP listener in front of the API router, used by the remote MCP endpoint to run
 * tools through the normal API routes with the caller's own credential (so authentication,
 * scopes, project access, the command guard, human approval and audit all apply unchanged).
 *
 * It listens on 127.0.0.1 with an ephemeral port, is created on first use, never keeps the
 * process alive, refuses requests without the per-process internal header, and only serves the
 * routes the MCP tools call. The real client address is passed in X-Forwarded-For (trusted from
 * loopback only) so audit entries keep it.
 */

/** Routes the shared MCP tools call (platform/api/src/mcp/registry.ts, remote mode). */
const TOOL_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/api\/health$/],
  ['GET', /^\/api\/openapi\.json$/],
  ['GET', /^\/api\/agent-tokens\/me$/],
  ['GET', /^\/api\/bootstrap\/status$/],
  ['GET', /^\/api\/bootstrap\/nodes$/],
  ['GET', /^\/api\/bootstrap\/pods$/],
  ['GET', /^\/api\/bootstrap\/pods\/[^/]+\/[^/]+\/logs$/],
  ['GET', /^\/api\/projects$/],
  ['GET', /^\/api\/projects\/[^/]+$/],
  ['GET', /^\/api\/logs\/search$/],
  ['GET', /^\/api\/audit-logs$/],
  ['POST', /^\/api\/agent\/commands\/validate$/],
  ['POST', /^\/api\/agent\/commands\/execute$/],
];

export function isToolRoute(method: string, path: string): boolean {
  return TOOL_ROUTES.some(([m, re]) => m === method && re.test(path));
}

function onlyToolRoutes(req: Request, res: Response, next: NextFunction) {
  if (!isToolRoute(req.method, req.path)) return res.status(404).json({ error: 'Not found' });
  return next();
}

let started: Promise<string> | null = null;
let server: http.Server | null = null;

export async function buildLoopbackApp(): Promise<express.Express> {
  // Imported lazily: routes/api pulls in every route module.
  const { default: apiRouter } = await import('../routes/api');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(markInternalMcpRequest);
  app.use(onlyToolRoutes);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', apiRouter);
  return app;
}

async function start(): Promise<string> {
  const app = await buildLoopbackApp();
  const srv = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  srv.unref();
  server = srv;
  const { port } = srv.address() as AddressInfo;
  return `http://127.0.0.1:${port}/api`;
}

export function loopbackApiBaseUrl(): Promise<string> {
  if (!started) {
    started = start().catch((err) => {
      started = null;
      throw err;
    });
  }
  return started;
}

/** Close the listener (tests, shutdown). */
export async function closeLoopbackServer(): Promise<void> {
  const srv = server;
  server = null;
  started = null;
  if (!srv) return;
  srv.closeAllConnections?.();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}
