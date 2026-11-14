import * as crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Marks requests the remote MCP endpoint makes to the API on behalf of a connected assistant.
 *
 * Remote MCP access tokens are audience-bound to /mcp: the public /api routes refuse them. MCP
 * tools still go through the normal API routes (same checks, guard and audit), so routes/mcp.ts
 * calls them through a separate loopback-only app (lib/mcp-loopback.ts). That app checks this
 * header (random per process, never leaves it) and then marks the request with a flag that only
 * it can set. The API trusts the flag, not the header; the public app strips the header.
 */
export const MCP_INTERNAL_HEADER = 'x-cairn-mcp-internal';

const INTERNAL_SECRET = crypto.randomBytes(32).toString('hex');

/** Set on the request object by the loopback app only (a Symbol cannot arrive over HTTP). */
const MCP_INTERNAL_FLAG: unique symbol = Symbol('cairn.mcpInternal');

export function mcpInternalSecret(): string {
  return INTERNAL_SECRET;
}

export function hasValidInternalHeader(req: Request): boolean {
  const value = req.headers[MCP_INTERNAL_HEADER];
  if (typeof value !== 'string' || value.length !== INTERNAL_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(INTERNAL_SECRET));
}

function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Loopback app only: first middleware. Refuses anything without the header, then marks the request. */
export function markInternalMcpRequest(req: Request, res: Response, next: NextFunction) {
  if (!hasValidInternalHeader(req) || !isLoopbackAddress(req.socket?.remoteAddress)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  (req as any)[MCP_INTERNAL_FLAG] = true;
  return next();
}

/** Public app: drop any client-supplied copy of the internal header before routing. */
export function stripInternalMcpHeader(req: Request, _res: Response, next: NextFunction) {
  if (MCP_INTERNAL_HEADER in req.headers) delete req.headers[MCP_INTERNAL_HEADER];
  next();
}

export function isInternalMcpRequest(req: Request): boolean {
  return (req as any)[MCP_INTERNAL_FLAG] === true;
}
