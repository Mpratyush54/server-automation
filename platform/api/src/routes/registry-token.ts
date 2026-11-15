import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { PULL_TOKEN_TTL_SECONDS, REGISTRY_SERVICE, mintRegistryToken, pullAccessFor, verifyPullCredential } from '../lib/registry-token';

/**
 * Docker registry token endpoint (realm) for the build registry. Only per-project pull
 * credentials are accepted here, and they only ever yield pull access to that project's
 * repositories. Build pushes and retention deletes use tokens the API mints directly.
 */
const router = Router();

function basic(req: Request): { username: string; password: string } | null {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const index = decoded.indexOf(':');
  return index > 0 ? { username: decoded.slice(0, index), password: decoded.slice(index + 1) } : null;
}

router.get('/registry/token', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.query.service !== REGISTRY_SERVICE) return res.status(400).json({ error: 'Unknown registry service' });
    const credentials = basic(req);
    const projectId = credentials ? await verifyPullCredential(credentials.username, credentials.password) : null;
    if (!projectId) {
      res.setHeader('WWW-Authenticate', 'Basic realm="cairn-registry"');
      return res.status(401).json({ error: 'Registry credentials required' });
    }
    const project = await (await getDb()).getRepository(Project).findOneBy({ id: projectId, isActive: true });
    if (!project) return res.status(401).json({ error: 'Registry credentials required' });
    const raw = req.query.scope;
    const scopes = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    const token = await mintRegistryToken(`project:${projectId}`, pullAccessFor(projectId, scopes), PULL_TOKEN_TTL_SECONDS);
    return res.json({ token, access_token: token, expires_in: PULL_TOKEN_TTL_SECONDS, issued_at: new Date().toISOString() });
  } catch {
    return res.status(503).json({ error: 'Registry token service unavailable' });
  }
});

// containerd tries the OAuth2 POST form first and falls back to GET on 404.
router.post('/registry/token', (_req: Request, res: Response) => res.status(404).json({ error: 'Use GET with Basic credentials' }));

export default router;
