import releaseRoutes from './releases';
import errorTrackingRoutes from './error-tracking';
import { Router } from 'express';
const router = Router();

import authRoutes from './auth';
import mfaRoutes from './mfa';
import oidcRoutes from './oidc';
import projectRoutes from './projects';
import projectArgoRoutes from './project-argocd';
import deploymentRoutes from './deployments';
import configRoutes from './config';
import secretRoutes from './secrets';
import environmentRoutes from './environment';
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
import { loadOpenApiJson, OpenApiUnavailableError } from '../lib/openapi-spec';
import healthRoutes from './health';
import operationRoutes from './operations';
import backupRoutes from './backups';
import telemetryRoutes from './telemetry';
import privacyRoutes from './privacy';
import gitAppRoutes from './git-apps';
import topologyRoutes from './topology';

router.use('/', errorTrackingRoutes);
router.use('/', healthRoutes); // GET /api/health/ready (readiness: DB only; Redis reported, not gating)
router.use('/', telemetryRoutes); // ingress-nginx external auth for the collector (#49); token-authenticated itself
router.use('/', privacyRoutes); // PII scrubbing, retention, consent hooks, GDPR delete (#47)
router.use('/', oidcRoutes); // before authRoutes: OIDC provider + GitHub/GitLab login (state cookie)
router.use('/', authRoutes);
router.use('/', mfaRoutes); // TOTP MFA: enrolment, login challenge, step-up (#24)
router.use('/', versionRoutes);
router.use('/', projectRoutes);
router.use('/', projectArgoRoutes);
router.use('/', deploymentRoutes);
router.use('/', releaseRoutes);
router.use('/', configRoutes);
router.use('/', secretRoutes);
router.use('/', environmentRoutes); // merged config + secrets view for the Environment tab (#29)
router.use('/', storageRoutes);
router.use('/', alertRoutes);
router.use('/', dbConnectionRoutes);
router.use('/', bootstrapRoutes);
router.use('/', webhookRoutes);
router.use('/', cicdRoutes);
router.use('/', sdkRoutes);
router.use('/', metricRoutes);
router.use('/', settingRoutes);
router.use('/', gitAppRoutes); // GitHub App manifest flow + GitLab OAuth app automation (#35)
router.use('/', auditLogRoutes);
router.use('/', bugReportRoutes);
router.use('/', dbProvisionRoutes);
router.use('/', agentTokenRoutes);
router.use('/', agentCommandRoutes);
router.use('/', notificationRoutes);
router.use('/', operationRoutes);
router.use('/', backupRoutes);
router.use('/', topologyRoutes); // GET /projects/:projectId/environments/:envId/topology (#31)

/** GET /api/openapi.json — OpenAPI 3 spec derived from openapi.yaml (parsed once, cached). */
router.get('/openapi.json', (_req, res) => {
  try {
    res.type('application/json').send(loadOpenApiJson());
  } catch (err: any) {
    res.status(500).json({ error: err instanceof OpenApiUnavailableError ? err.message : 'Failed to load OpenAPI spec' });
  }
});

router.use((req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

export default router;
