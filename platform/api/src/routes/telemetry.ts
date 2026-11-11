import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createLimiterStore } from '../lib/rate-limit-store';
import { ingestAuthRateLimit } from '../lib/telemetry-config';
import {
  IngestClaims,
  originAllowed,
  scopeForPath,
  TelemetryKeyUnavailableError,
  tokenTypeAllowedFor,
  verifyIngestToken,
} from '../lib/telemetry-tokens';

/**
 * Collector auth for ingress-nginx external auth (issue #49).
 *
 * The otel.<DOMAIN> Ingress calls GET /api/telemetry/ingest-auth for every request
 * (cached by ingress-nginx). We validate the bearer ingest token — HMAC signature
 * (constant time), expiry, token type vs the collector path (X-Original-URL), and for
 * browser tokens the Origin header — and answer:
 *   200 + X-Platform-Project-Id / X-Platform-Environment  (Alloy turns these into
 *       platform.project_id / deployment.environment resource attributes)
 *   401 for anything else (missing/invalid/expired/wrong scope/origin)
 *   429 when one token exceeds its per-minute budget (Redis-backed, shared by replicas)
 *   503 when the signing key cannot be loaded
 * No database access: verification is a single HMAC.
 *
 * nginx `auth_request` only passes 401/403 through; any other status becomes a 500 for
 * the client. The platformctl telemetry Ingress therefore calls this endpoint with
 * `?errors=mapped`: throttling and key outages are then answered as 403 plus
 * `X-Platform-Auth-Status: 429|503` (+ Retry-After, + the validated Origin for browser
 * tokens), and the Ingress' error_page turns that into a real 429/503 with Retry-After
 * and CORS headers. Without the parameter (older Ingress) the plain status is kept.
 */

const router = Router();

interface IngestLocals {
  claims: IngestClaims;
  tokenKey: string;
}

function deny(res: Response, reason: string) {
  res.setHeader('WWW-Authenticate', 'Bearer realm="platform-telemetry"');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(401).json({ error: 'Unauthorized', reason });
}

/** Called by an Ingress that maps 403 + X-Platform-Auth-Status back to the real status. */
function mappedErrors(req: Request): boolean {
  return req.query.errors === 'mapped';
}

/**
 * Answer a retryable failure (429/503). Behind a mapping Ingress it is sent as 403 with
 * the real status in X-Platform-Auth-Status, because auth_request turns 429/503 into 500.
 */
function retryable(req: Request, res: Response, status: 429 | 503, retryAfterSeconds: number, body: object) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  if (!mappedErrors(req)) return res.status(status).json(body);
  res.setHeader('X-Platform-Auth-Status', String(status));
  // Only an Origin that this token was verified for is echoed (CORS on the 429 lets the
  // browser SDK read Retry-After). Server tokens and preflights never get one.
  const locals = res.locals.ingest as IngestLocals | undefined;
  const origin = req.header('Origin');
  if (locals?.claims.typ === 'web' && origin && originAllowed(origin, locals.claims.origins)) {
    res.setHeader('X-Platform-Allowed-Origin', origin);
  }
  return res.status(403).json(body);
}

function originalPath(req: Request): string | null {
  const raw = req.header('X-Original-URL') || req.header('X-Original-Uri') || req.header('X-Forwarded-Uri');
  if (!raw) return null;
  try {
    return new URL(raw, 'http://collector.invalid').pathname;
  } catch {
    return null;
  }
}

async function validateIngestToken(req: Request, res: Response, next: NextFunction) {
  const path = originalPath(req);
  const scope = path === null ? undefined : scopeForPath(path);
  const method = String(req.header('X-Original-Method') || '').toUpperCase();

  // CORS preflight to the Faro receiver carries no credentials; let Alloy answer it.
  if (method === 'OPTIONS' && scope === 'rum') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).end();
  }

  const auth = req.header('Authorization') || '';
  if (!/^Bearer\s+/i.test(auth)) return deny(res, 'missing_token');
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  let result;
  try {
    result = await verifyIngestToken(token);
  } catch (err) {
    if (err instanceof TelemetryKeyUnavailableError) {
      return retryable(req, res, 503, 30, { error: 'Telemetry auth temporarily unavailable' });
    }
    return deny(res, 'invalid_token');
  }
  if (result.ok === false) return deny(res, result.reason);
  const { claims } = result;

  // Scope: browser tokens only for Faro (/collect), server tokens only for OTLP + profiles.
  // When the original URL is unknown (direct call) only the token itself is checked.
  if (scope !== undefined && !tokenTypeAllowedFor(claims.typ, scope)) return deny(res, 'wrong_scope');
  if (claims.typ === 'web' && !originAllowed(req.header('Origin'), claims.origins)) return deny(res, 'origin_not_allowed');

  const locals: IngestLocals = {
    claims,
    tokenKey: crypto.createHash('sha256').update(token).digest('base64url').slice(0, 32),
  };
  res.locals.ingest = locals;
  return next();
}

const perTokenLimiter = rateLimit({
  windowMs: 60_000,
  limit: (_req: Request, res: Response) => ingestAuthRateLimit((res.locals.ingest as IngestLocals).claims.typ),
  keyGenerator: (_req: Request, res: Response) => (res.locals.ingest as IngestLocals).tokenKey,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: false,
  handler: (req: Request, res: Response) => {
    const reset = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
    const secs = reset instanceof Date ? (reset.getTime() - Date.now()) / 1000 : 60;
    return retryable(req, res, 429, Number.isFinite(secs) ? secs : 60, { error: 'Too many telemetry requests for this token. Retry later.' });
  },
  store: createLimiterStore('ingest-auth'),
});

function allow(_req: Request, res: Response) {
  const { claims } = res.locals.ingest as IngestLocals;
  const remaining = Math.max(0, claims.exp - Math.floor(Date.now() / 1000));
  res.setHeader('X-Platform-Project-Id', claims.projectId);
  res.setHeader('X-Platform-Environment', claims.environment);
  res.setHeader('X-Platform-Token-Type', claims.typ);
  // Safe for a short shared cache keyed on Authorization (+ Origin), never past expiry.
  res.setHeader('Cache-Control', `private, max-age=${Math.min(60, remaining)}`);
  return res.status(200).end();
}

// ingress-nginx may forward the original method (POST for OTLP); answer every method.
router.all('/telemetry/ingest-auth', validateIngestToken, perTokenLimiter, allow);

export default router;
