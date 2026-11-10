/**
 * GET /projects/:projectId/environments/:envId/topology — live, read-only
 * resource graph for one project environment (issue #31).
 *
 * Scoped to the environment's server-assigned namespace; `envId` is the
 * environment UUID (an environment name such as `staging` is accepted too).
 */
import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { Environment } from '../entities/Environment';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { expressAuthenticate, AuthenticatedRequest } from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { assignedNamespace } from '../lib/project-namespace';
import { buildTopology } from '../lib/topology';
import { fetchTopologySources } from '../lib/topology-k8s';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/projects/:projectId/environments/:envId/topology', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, envId } = req.params;
    const access = await requireProjectAccess(req as AuthenticatedRequest, projectId, ProjectAccessRole.VIEWER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const envRepo = ds.getRepository(Environment);
    const env = UUID_RE.test(envId)
      ? await envRepo.findOne({ where: { id: envId, projectId } })
      : await envRepo.findOne({ where: { name: envId as any, projectId } });
    if (!env) return res.status(404).json({ error: 'Environment not found' });

    // Same resolution as the deploy path / argocd-status: the stored namespace is
    // the Argo Application name and the target namespace.
    const namespace = env.namespace || assignedNamespace(project.name, String(env.name), project.id);
    const appName = namespace;

    const { sources, warnings } = await fetchTopologySources(namespace, appName);
    const graph = buildTopology(sources);
    res.set('Cache-Control', 'no-store');
    return res.json({ ...graph, environmentId: env.id, environment: env.name, warnings });
  } catch (err: any) {
    const status = err?.status === 503 ? 503 : 500;
    return res.status(status).json({ error: status === 503 ? err.message : 'Failed to build topology' });
  }
});

export default router;
