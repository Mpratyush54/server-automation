import 'dotenv/config';
import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { getDb } from './config/database';
import { connectMongo } from './config/mongoose';
import { User } from './entities/User';
import apiRouter from './routes/api';
import { startPreviewDecayScheduler } from './lib/preview-decay';
import { configuredAdminEmail, ensureAdminUser } from './lib/seed-admin';

async function bootstrap() {
  try {
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

    const app = express();
    const port = process.env.PORT || 3000;

    // Middleware
    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(morgan('dev'));

    // Main API routing
    app.use('/api', apiRouter);

    // Fallback route handler
    app.use((req, res) => {
      res.status(404).json({ error: `Route not found: ${req.method} ${req.url}` });
    });

    app.listen(port, () => {
      console.log(`[server] Platform Express backend running on http://localhost:${port}`);
    });
  } catch (err: any) {
    console.error('[server] Bootstrapping failed:', err.message);
    process.exit(1);
  }
}

bootstrap();
