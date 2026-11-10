/**
 * Automated Git provider connect (#35): GitHub App Manifest flow, GitHub App installations,
 * and GitLab OAuth application creation. Reads are open to DevOps (like GET
 * /settings/integrations); every write is admin-only, audited, and creating/replacing/removing
 * provider credentials needs a recent MFA step-up (requireRecentMfa), like secret rotation.
 * No endpoint ever returns a client secret, webhook secret, private key or token.
 */
import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { UserRole } from '../entities/User';
import { GitAppInstallation } from '../entities/GitAppInstallation';
import { expressAuthenticate, expressRequireRole, requireRecentMfa, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { apiBase, portalBase } from '../lib/oauth-login';
import { applyIntegrationsToEnv, resolveIntegrations } from '../lib/integrations';
import { deleteProviderApp, loadProviderApp, publicAppView } from '../lib/git-app-store';
import {
  GithubAppError, checkGithubAppHealth, clearInstallationTokenCache, completeManifestFlow,
  fetchInstallationRepositories, listInstallations, loadGithubApp, projectsForInstallation,
  startManifestFlow, syncInstallations,
} from '../lib/github-app';
import { GitlabAppError, checkGitlabAppHealth, connectGitlab } from '../lib/gitlab-app';
import { StateStoreUnavailableError } from '../lib/redis';

const router = Router();

const adminOnly = expressRequireRole([]); // UserRole.ADMIN always passes expressRequireRole
const devopsRead = expressRequireRole([UserRole.DEVOPS]);

function proto(req: Request): string {
  return (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || req.protocol || 'https';
}

function bases(req: Request) {
  const host = req.get('host') || undefined;
  return { api: apiBase(host, proto(req)), portal: portalBase(host, proto(req)) };
}

/** Problems that stop GitHub/GitLab from reaching this install (callbacks, webhooks). */
function reachabilityWarnings(api: string): string[] {
  const out: string[] = [];
  try {
    const u = new URL(api);
    if (u.protocol !== 'https:') out.push('The public API URL is not HTTPS; GitHub and GitLab require HTTPS callback URLs.');
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname) || u.hostname.endsWith('.local')) {
      out.push('The public API URL is not publicly reachable. Use a real domain (an sslip.io name such as <ip>.sslip.io works) so webhooks can be delivered.');
    }
  } catch {
    out.push('The public API URL could not be determined; set DOMAIN or API_PUBLIC_URL.');
  }
  return out;
}

function sendError(res: Response, err: any) {
  if (err instanceof StateStoreUnavailableError) return res.status(503).json({ error: 'State store unavailable. Try again in a moment.' });
  if (err instanceof GithubAppError) return res.status(err.status).json({ error: err.message });
  if (err instanceof GitlabAppError) return res.status(err.status).json({ error: err.message, ...err.extra });
  return res.status(400).json({ error: err?.message || String(err) });
}

function userId(req: Request): string {
  return (req as AuthenticatedRequest).user?.id || '';
}

async function refreshEnv() {
  try { applyIntegrationsToEnv(await resolveIntegrations()); } catch { /* best effort */ }
}

// ── Status ───────────────────────────────────────────────────────────────────

router.get('/settings/integrations/git', expressAuthenticate, devopsRead, async (req: Request, res: Response) => {
  try {
    const { api, portal } = bases(req);
    const [gh, gl, installations, resolved] = await Promise.all([
      loadProviderApp('github'), loadProviderApp('gitlab'), listInstallations(), resolveIntegrations(),
    ]);
    return res.json({
      github: {
        ...publicAppView(gh),
        installations: installations.length,
        loginSource: resolved.githubSource,
        loginEnabled: resolved.githubLoginEnabled,
        linkingTokenFallback: Boolean(process.env.GITHUB_TOKEN),
      },
      gitlab: {
        ...publicAppView(gl),
        loginSource: resolved.gitlabSource,
        loginEnabled: resolved.gitlabLoginEnabled,
        url: resolved.gitlabUrl,
      },
      publicUrls: { api, portal },
      callbackUrls: {
        github: `${api}/api/auth/github/callback`,
        gitlab: `${api}/api/auth/gitlab/callback`,
        githubWebhook: `${api}/api/webhooks/github`,
        gitlabWebhook: `${api}/api/webhooks/gitlab`,
      },
      warnings: reachabilityWarnings(api),
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// ── GitHub App Manifest flow ─────────────────────────────────────────────────

router.post('/settings/integrations/github/manifest', expressAuthenticate, adminOnly, requireRecentMfa(), async (req: Request, res: Response) => {
  try {
    const { api, portal } = bases(req);
    const b = req.body || {};
    const out = await startManifestFlow({
      userId: userId(req),
      ownerType: b.ownerType,
      org: b.org,
      name: typeof b.name === 'string' ? b.name : undefined,
      apiBase: api,
      portalBase: portal,
    });
    await logAudit({
      userId: userId(req),
      action: 'settings.git.github.manifest_started',
      targetType: 'GitProviderApp',
      metadata: { ownerType: b.ownerType === 'org' ? 'org' : 'user', org: b.ownerType === 'org' ? String(b.org || '') : null },
      ip: req.ip,
    });
    return res.json({ ...out, warnings: reachabilityWarnings(api) });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/settings/integrations/github/manifest/complete', expressAuthenticate, adminOnly, requireRecentMfa(), async (req: Request, res: Response) => {
  try {
    const { row, installUrl } = await completeManifestFlow({ code: req.body?.code, state: req.body?.state, userId: userId(req) });
    await refreshEnv();
    await logAudit({
      userId: userId(req),
      action: 'settings.git.github.connected',
      targetType: 'GitProviderApp',
      targetId: row.id,
      metadata: { appId: row.appId, slug: row.slug, owner: row.owner, ownerType: row.ownerType },
      ip: req.ip,
    });
    return res.json({ ok: true, installUrl, github: publicAppView(row) });
  } catch (err) {
    return sendError(res, err);
  }
});

// ── GitHub App installations ─────────────────────────────────────────────────

async function installationsView() {
  const ds = await getDb();
  const projects = await ds.getRepository(Project).find({ select: ['id', 'name', 'repositoryUrl'] as any });
  const rows = await listInstallations();
  return rows.map((i: GitAppInstallation) => ({
    installationId: i.installationId,
    account: i.accountLogin,
    accountType: i.accountType,
    repositorySelection: i.repositorySelection,
    repositories: i.repositories || [],
    suspended: Boolean(i.suspendedAt),
    projects: projectsForInstallation(i, projects).map((p) => ({ id: p.id, name: p.name, repositoryUrl: p.repositoryUrl })),
  }));
}

router.get('/settings/integrations/github/installations', expressAuthenticate, devopsRead, async (_req: Request, res: Response) => {
  try {
    return res.json({ installations: await installationsView() });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/settings/integrations/github/installations/sync', expressAuthenticate, adminOnly, async (req: Request, res: Response) => {
  try {
    const rows = await syncInstallations();
    await logAudit({ userId: userId(req), action: 'settings.git.github.installations_synced', targetType: 'GitProviderApp', metadata: { count: rows.length }, ip: req.ip });
    return res.json({ installations: await installationsView() });
  } catch (err) {
    return sendError(res, err);
  }
});

/** Repositories the App can access, for linking a project without a personal token. */
router.get('/settings/integrations/github/repositories', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (_req: Request, res: Response) => {
  try {
    const app = await loadGithubApp();
    if (!app) return res.status(409).json({ error: 'GitHub App is not connected' });
    const repositories: any[] = [];
    for (const inst of await listInstallations()) {
      if (inst.suspendedAt) continue;
      for (const r of await fetchInstallationRepositories(inst.installationId, app)) {
        repositories.push({ ...r, installationId: inst.installationId });
      }
    }
    return res.json({ repositories });
  } catch (err) {
    return sendError(res, err);
  }
});

// ── GitLab OAuth application ─────────────────────────────────────────────────

router.post('/settings/integrations/gitlab/connect', expressAuthenticate, adminOnly, requireRecentMfa(), async (req: Request, res: Response) => {
  try {
    const { api } = bases(req);
    const b = req.body || {};
    const { row, mode, tokenKept } = await connectGitlab({
      baseUrl: b.baseUrl,
      token: b.token,
      groupPath: b.groupPath,
      keepToken: b.keepToken,
      appName: b.appName,
      redirectUri: `${api}/api/auth/gitlab/callback`,
      userId: userId(req),
    });
    await refreshEnv();
    await logAudit({
      userId: userId(req),
      action: 'settings.git.gitlab.connected',
      targetType: 'GitProviderApp',
      targetId: row.id,
      metadata: { baseUrl: row.baseUrl, mode, group: row.owner, tokenKept },
      ip: req.ip,
    });
    return res.json({ ok: true, mode, tokenKept, gitlab: publicAppView(row) });
  } catch (err) {
    return sendError(res, err);
  }
});

// ── Health / disconnect (both providers) ─────────────────────────────────────

function providerParam(req: Request): 'github' | 'gitlab' | null {
  const p = String(req.params.provider || '');
  return p === 'github' || p === 'gitlab' ? p : null;
}

router.post('/settings/integrations/:provider/check', expressAuthenticate, adminOnly, async (req: Request, res: Response) => {
  try {
    const provider = providerParam(req);
    if (!provider) return res.status(404).json({ error: 'Unknown provider' });
    const result = provider === 'github' ? await checkGithubAppHealth() : await checkGitlabAppHealth();
    await logAudit({ userId: userId(req), action: `settings.git.${provider}.checked`, targetType: 'GitProviderApp', metadata: { ok: result.ok }, ip: req.ip });
    return res.json({ provider, ...result });
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/settings/integrations/:provider/app', expressAuthenticate, adminOnly, requireRecentMfa(), async (req: Request, res: Response) => {
  try {
    const provider = providerParam(req);
    if (!provider) return res.status(404).json({ error: 'Unknown provider' });
    const removed = await deleteProviderApp(provider);
    if (provider === 'github') {
      // Installations belong to the removed App.
      const ds = await getDb();
      await ds.getRepository(GitAppInstallation).clear();
      await clearInstallationTokenCache();
    }
    await refreshEnv();
    await logAudit({ userId: userId(req), action: `settings.git.${provider}.disconnected`, targetType: 'GitProviderApp', metadata: { removed }, ip: req.ip });
    return res.json({
      ok: true,
      removed,
      note: provider === 'github'
        ? 'Stored App credentials were removed. Delete the App itself on GitHub (Settings > Developer settings > GitHub Apps) if it is no longer needed.'
        : 'Stored application credentials were removed. Delete the OAuth application in GitLab if it is no longer needed.',
    });
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
