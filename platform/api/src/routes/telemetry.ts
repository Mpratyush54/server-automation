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
 * No database access: verification is a single HMAC.
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
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'Telemetry auth temporarily unavailable' });
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
  message: { error: 'Too many telemetry requests for this token. Retry later.' },
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
