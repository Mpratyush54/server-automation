import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Alert } from '../entities/Alert';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

router.get('/alerts', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as Record<string, string>;
    const ds = await getDb();
    const filter = projectId ? { projectId } : {};
    const alerts = await ds.getRepository(Alert).find({ where: filter });
    return res.json(alerts);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/alerts', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(Alert);

    const alert = repo.create({
      projectId: body.projectId,
      type: body.type || body.config?.metric || 'cpu_high',
      severity: body.severity || 'warning',
      config: body.config || {},
      isEnabled: body.enabled !== false,
    });
    const saved = await repo.save(alert);
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

    if (body.enabled !== undefined) alert.isEnabled = body.enabled;
    if (body.config !== undefined) alert.config = body.config;
    if (body.severity !== undefined) alert.severity = body.severity;

    await repo.save(alert);
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
    await repo.remove(alert);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/alerts/evaluate', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, metrics } = req.body;
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
