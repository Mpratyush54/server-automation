import express from 'express';
import helmet from 'helmet';
import { runnerRouter } from './routes/synthetics';

/**
 * Browser synthetic runner listener (#42): only the per-check runner endpoints
 * (GET definition, POST result), on their own port, so the runner pods' egress
 * NetworkPolicy can allow exactly this port of the API and nothing else of it.
 * Body limit: a 2 MiB PNG screenshot base64-encoded plus the step report.
 */
export function buildSyntheticsRunnerApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '4mb' }));
  app.use('/api', runnerRouter);
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  return app;
}

/** SYNTHETICS_RUNNER_PORT (default 3001); "off" or 0 disables the listener. */
export function syntheticsRunnerPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env.SYNTHETICS_RUNNER_PORT ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0') return null;
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n > 0 && n < 65536 ? n : 3001;
}
