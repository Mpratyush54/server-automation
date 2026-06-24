import 'dotenv/config';
import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { getDb } from './config/database';
import { connectMongo } from './config/mongoose';
import { User, UserRole } from './entities/User';
import apiRouter from './routes/api';
import { startPreviewDecayScheduler } from './lib/preview-decay';

async function bootstrap() {
  try {
    console.log('[server] Initializing database connections...');
    // Initialize PostgreSQL
    const ds = await getDb();
    console.log(`[server] PostgreSQL connected to database: ${ds.options.database}`);

    // Seed demo users automatically if database is empty
    const userRepo = ds.getRepository(User);
    const userCount = await userRepo.count();
    if (userCount === 0) {
      console.log('[server] Seeding demo users in PostgreSQL...');
      const demoUsers = [
        userRepo.create({
          id: '11111111-1111-1111-1111-111111111111',
          name: 'John Dev',
          email: 'john@caps.io',
          role: UserRole.DEVELOPER,
        }),
        userRepo.create({
          id: '22222222-2222-2222-2222-222222222222',
          name: 'Sarah Lead',
          email: 'sarah@caps.io',
          role: UserRole.TECH_LEAD,
        }),
        userRepo.create({
          id: '33333333-3333-3333-3333-333333333333',
          name: 'DevOps Boss',
          email: 'devops@caps.io',
          role: UserRole.DEVOPS,
        }),
      ];
      await userRepo.save(demoUsers);
      console.log('[server] Seeding completed');
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
      console.log(`[server] CAPS PaaS Express backend running on http://localhost:${port}`);
    });
  } catch (err: any) {
    console.error('[server] Bootstrapping failed:', err.message);
    process.exit(1);
  }
}

bootstrap();
