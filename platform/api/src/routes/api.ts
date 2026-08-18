import { Router } from 'express';
import fs from 'fs';
import path from 'path';
const router = Router();

import authRoutes from './auth';
import projectRoutes from './projects';
import deploymentRoutes from './deployments';
import configRoutes from './config';
import secretRoutes from './secrets';
import storageRoutes from './storage';
import alertRoutes from './alerts';
import dbConnectionRoutes from './db-connections';
import bootstrapRoutes from './bootstrap';
import webhookRoutes from './webhooks';
import cicdRoutes from './cicd';
import sdkRoutes from './sdk';
import metricRoutes from './metrics';
import settingRoutes from './settings';
import auditLogRoutes from './audit-logs';
import bugReportRoutes from './bug-reports';
import dbProvisionRoutes from './db-provision';
import versionRoutes from './version';
import agentTokenRoutes from './agent-tokens';
import agentCommandRoutes from './agent-commands';
import notificationRoutes from './notifications';

router.use('/', authRoutes);
router.use('/', versionRoutes);
router.use('/', projectRoutes);
router.use('/', deploymentRoutes);
router.use('/', configRoutes);
router.use('/', secretRoutes);
router.use('/', storageRoutes);
router.use('/', alertRoutes);
router.use('/', dbConnectionRoutes);
router.use('/', bootstrapRoutes);
router.use('/', webhookRoutes);
router.use('/', cicdRoutes);
router.use('/', sdkRoutes);
router.use('/', metricRoutes);
router.use('/', settingRoutes);
router.use('/', auditLogRoutes);
router.use('/', bugReportRoutes);
router.use('/', dbProvisionRoutes);
router.use('/', agentTokenRoutes);
router.use('/', agentCommandRoutes);
router.use('/', notificationRoutes);

/** GET /api/openapi.json — OpenAPI 3 spec derived from openapi.yaml */
router.get('/openapi.json', (_req, res) => {
  try {
    const yamlPath = path.join(__dirname, '..', '..', 'openapi.yaml');
    const raw = fs.readFileSync(yamlPath, 'utf8');
    // Prefer js-yaml when available; fall back to bundled JSON companion.
    let spec: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const yaml = require('yaml');
      spec = yaml.parse(raw);
    } catch {
      const jsonPath = path.join(__dirname, '..', '..', 'openapi.json');
      if (fs.existsSync(jsonPath)) {
        spec = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } else {
        return res.status(500).json({ error: 'OpenAPI spec unavailable' });
      }
    }
    res.json(spec);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to load OpenAPI spec' });
  }
});

router.use((req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

export default router;
