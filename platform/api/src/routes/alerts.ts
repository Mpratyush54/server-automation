import { requireProjectAccess, listAccessibleProjectIds } from '../lib/project-access';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { In } from 'typeorm';
import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Alert } from '../entities/Alert';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, AuthenticatedRequest } from '../middleware/auth';
import { AlertMonitor } from '../entities/AlertMonitor';
import { legacyAlertToMonitor } from '../lib/alerting-rules';
import { scheduleRulesSync } from '../lib/alerting-k8s';

/**
 * Legacy alert rules (pre-#43). Kept for API compatibility: every row is mirrored to an
 * alert_monitors row (legacy_alert_id), which the rule-based alerting of /alerting evaluates
 * and routes. New clients should use /projects/:projectId/alerting/monitors.
 * POST /alerts/evaluate (client-supplied metric values) is deprecated: it still answers as
 * before but notifies nobody; real evaluation is rule-based (Prometheus ruler or API evaluator).
 */
const router = Router();

async function mirrorLegacy(alert: Alert, removed = false): Promise<void> {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(AlertMonitor);
    const existing = await repo.findOne({ where: { legacyAlertId: alert.id } });
    if (removed) {
      if (existing) await repo.delete({ id: existing.id });
    } else {
      const fields = legacyAlertToMonitor(alert as any);
      const row: AlertMonitor = existing ? Object.assign(existing, { ...fields, name: existing.name }) as AlertMonitor : repo.create({ ...fields, state: 'ok' } as any) as unknown as AlertMonitor;
      await repo.save(row);
    }
    scheduleRulesSync(alert.projectId);
  } catch (err: any) {
    console.warn(`[alerts] legacy rule mirror failed for ${alert.id}: ${err?.message || err}`);
  }
}

router.get('/alerts', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as Record<string, string>;
    const ds = await getDb();
    const ids = await listAccessibleProjectIds((req as AuthenticatedRequest).user, (req as AuthenticatedRequest).agentToken);
    if (projectId) {
      const access = await requireProjectAccess(req as AuthenticatedRequest, String(projectId), ProjectAccessRole.VIEWER);
      if (access.ok === false) return res.status(access.status).json({ error: access.error });
    }
    const filter = projectId ? { projectId: String(projectId) } : ids === null ? {} : { projectId: In(ids) };
    const alerts = await ds.getRepository(Alert).find({ where: filter });
    return res.json(alerts);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/alerts', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body?.projectId) return res.status(400).json({ error: 'projectId is required' });
    if (!body?.type) return res.status(400).json({ error: 'type is required' });
    if (!body?.config) return res.status(400).json({ error: 'config is required' });
    const ds = await getDb();
    const repo = ds.getRepository(Alert);

    const access = await requireProjectAccess(req as AuthenticatedRequest, String(body.projectId || ''), ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const alert = repo.create({
      projectId: body.projectId,
      type: body.type || body.config?.metric || 'cpu_high',
      severity: body.severity || 'warning',
      config: body.config || {},
      isEnabled: body.enabled !== false,
    });
    const saved = await repo.save(alert);
    await mirrorLegacy(saved);
    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/alerts/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(Alert);
    const alert = await repo.findOne({ where: { id: req.params.id } });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    const access = await requireProjectAccess(req as AuthenticatedRequest, alert.projectId, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });


    if (body.enabled !== undefined) alert.isEnabled = body.enabled;
    if (body.config !== undefined) alert.config = body.config;
    if (body.severity !== undefined) alert.severity = body.severity;

    await repo.save(alert);
    await mirrorLegacy(alert);
    return res.json(alert);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/alerts/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(Alert);
    const alert = await repo.findOne({ where: { id: req.params.id } });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    const access = await requireProjectAccess(req as AuthenticatedRequest, alert.projectId, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    await repo.remove(alert);
    await mirrorLegacy(alert, true);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/alerts/evaluate', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/projects/{projectId}/alerting/monitors>; rel="successor-version"');
    const { projectId, metrics } = req.body;
    const access = await requireProjectAccess(req as AuthenticatedRequest, String(projectId || ''), ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    const ds = await getDb();
    const repo = ds.getRepository(Alert);
    const rules = await repo.find({ where: { projectId, isEnabled: true } });

    const triggered = [];
    for (const rule of rules) {
      const metricVal = metrics[(rule.config as any)?.metric];
      if (metricVal !== undefined) {
        let isTriggered = false;
        if (rule.config.operator === '>' && metricVal > (rule.config as any).threshold) isTriggered = true;
        if (rule.config.operator === '<' && metricVal < (rule.config as any).threshold) isTriggered = true;
        if (rule.config.operator === '==' && metricVal == (rule.config as any).threshold) isTriggered = true;

        if (isTriggered) {
          triggered.push({
            ruleId: rule.id,
            metric: (rule.config as any).metric,
            value: metricVal,
            threshold: (rule.config as any).threshold,
            severity: rule.severity,
          });
        }
      }
    }
    return res.json({ evaluatedCount: rules.length, triggered });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
