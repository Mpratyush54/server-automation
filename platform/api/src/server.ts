import 'dotenv/config';
import 'reflect-metadata';
import express from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import { validateSecurityEnv, resolveCorsOrigins } from './config/security-env';
import { getDb } from './config/database';
import { connectMongo } from './config/mongoose';
import { User } from './entities/User';
import apiRouter from './routes/api';
import { startPreviewDecayScheduler } from './lib/preview-decay';
import { configuredAdminEmail, ensureAdminUser } from './lib/seed-admin';

/** Paths called cross-origin by browser SDKs (bearer SDK token, no cookies). */
const SDK_PUBLIC_PATH = /^\/api\/(sdk\/|logs\/ingest$)/;

/** JSON body parser that keeps the raw bytes on req.rawBody (webhook signature verification). */
export const jsonBodyParser = express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { (req as any).rawBody = buf; },
});

/**
 * Request URL for access logs with every query-string value redacted. OAuth `code`/`state`,
 * one-time exchange codes and any legacy `?token=` must never reach log storage.
 */
export function redactUrlForLog(url: string | undefined): string {
  if (!url) return '-';
  const q = url.indexOf('?');
  if (q === -1) return url;
  const query = url.slice(q + 1).split('#')[0];
  const redacted = query
    .split('&')
    .filter(Boolean)
    .map((pair) => `${pair.split('=')[0]}=[REDACTED]`)
    .join('&');
  return `${url.slice(0, q)}?${redacted}`;
}

morgan.token('redacted-url', (req: express.Request) => redactUrlForLog(req.originalUrl || req.url));

/** Access logger (morgan) that never logs query-string values. */
export function requestLogger(options: morgan.Options<express.Request, express.Response> = {}) {
  return morgan(':method :redacted-url :status :response-time ms - :res[content-length]', options);
}

export function buildApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1); // behind the ingress controller; needed for per-IP rate limiting

  const allowedOrigins = new Set(resolveCorsOrigins());
  const corsDelegate = (req: express.Request, cb: (err: Error | null, options?: CorsOptions) => void) => {
    if (SDK_PUBLIC_PATH.test(req.path)) {
      // Browser SDKs run on customer origins; auth is a bearer SDK token, never cookies.
      return cb(null, { origin: true, credentials: false });
    }
    const origin = req.header('Origin');
    cb(null, { origin: !!origin && allowedOrigins.has(origin.replace(/\/+$/, '')), credentials: false });
  };

  // Middleware
  // Portal and API share a site behind the ingress; 'same-site' keeps sibling subdomains working.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors(corsDelegate));

  // Brute-force protection on credential endpoints
  const credentialLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again later.' },
  });
  app.use(
    [
      '/api/auth/login',
      '/api/auth/set-password',
      '/api/oauth/token',
      '/api/auth/github/callback',
      '/api/auth/gitlab/callback',
    ],
    credentialLimiter,
  );
  // Credential-issuing endpoints (SDK tokens, agent tokens): limit creation, not listing.
  const issueLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.CREDENTIAL_ISSUE_RATE_LIMIT_MAX) || 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many credential requests. Please try again later.' },
  });
  app.post(['/api/projects/:projectId/tokens', '/api/agent-tokens'], issueLimiter);

  // Keep the raw body for webhook signature verification (req.rawBody).
  app.use(jsonBodyParser);
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger());

  // Main API routing
  app.use('/api', apiRouter);

  // Fallback route handler
  app.use((req, res) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.url}` });
  });
  return app;
}

async function bootstrap() {
  try {
    const problems = validateSecurityEnv();
    if (problems.length > 0) {
      console.error('[server] Refusing to start — insecure or missing configuration:');
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }

    console.log('[server] Initializing database connections...');
    // Initialize PostgreSQL
    const ds = await getDb();
    console.log(`[server] PostgreSQL connected to database: ${ds.options.database}`);
    try {
      const { recoverRedisAuth } = await import('./lib/credential-recover');
      const redisHeal = await recoverRedisAuth();
      if (!redisHeal.ok) {
        console.warn(`[server] Redis self-recovery: ${redisHeal.detail}`);
      }
    } catch (redisErr: any) {
      console.warn(`[server] Redis self-recovery skipped: ${redisErr.message}`);
    }

    // One admin from ADMIN_EMAIL / ADMIN_PASSWORD (platformctl prompt). No demo roster.
    const userRepo = ds.getRepository(User);
    const seeded = await ensureAdminUser(userRepo);
    if (seeded.created) {
      console.log(`[server] Created admin login ${configuredAdminEmail()}`);
    } else {
      console.log(`[server] Admin login ready: ${configuredAdminEmail()}`);
    }
    if (seeded.removedDemo > 0) {
      console.log(`[server] Removed ${seeded.removedDemo} leftover demo user(s)`);
    }

    // Initialize MongoDB
    try {
      await connectMongo();
      console.log('[server] MongoDB connected');
    } catch (mongoErr: any) {
      console.warn(`[server] MongoDB connection failed (non-blocking): ${mongoErr.message}`);
    }

    // Start preview environment decay scheduler (72h TTL)
    startPreviewDecayScheduler();

    try {
      const { hydrateIntegrationsEnv } = await import('./lib/integrations');
      await hydrateIntegrationsEnv();
      console.log('[server] Integration credentials loaded');
    } catch (integErr: any) {
      console.warn(`[server] Integration hydrate skipped: ${integErr.message}`);
    }

    const app = buildApp();
    const port = process.env.PORT || 3000;

    app.listen(port, () => {
      console.log(`[server] Platform Express backend running on http://localhost:${port}`);
    });
  } catch (err: any) {
    console.error('[server] Bootstrapping failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrap();
}
