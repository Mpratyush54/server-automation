import { parseGitRemote } from './git-remote';
import { mintScopedInstallationToken, revokeInstallationToken } from './github-app';
import { gitlabApiToken } from './gitlab-app';

/**
 * Source access for builds. Every clone gets its own narrowly scoped, short-lived credential:
 * - GitHub: an uncached App installation token limited to the linked repository, contents:read.
 * - GitLab: a per-build project deploy token with read_repository only.
 * There is no fallback to a personal or instance-wide token. The credential is revoked as soon
 * as the clone step finishes (and again, idempotently, when the build ends).
 */
export class BuildSourceError extends Error {}

export type CloneRevocation = { provider: 'github'; token: string } | { provider: 'gitlab'; project: string; tokenId: number };
export interface CloneCredential { url: string; header: string; secret: string; revoke: CloneRevocation }

const GITLAB_DEPLOY_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function gitlabOrigin(): string { return new URL(process.env.GITLAB_URL || 'https://gitlab.com').origin; }

function basicHeader(user: string, secret: string): string {
  return `Authorization: Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
}

export async function mintCloneCredential(repositoryUrl: string, buildId: string): Promise<CloneCredential> {
  const parsed = parseGitRemote(repositoryUrl);
  if (!parsed || parsed.provider === 'unknown') throw new BuildSourceError('Builds require a linked GitHub or GitLab repository');
  if (parsed.provider === 'github') {
    const { token } = await mintScopedInstallationToken(parsed.owner, parsed.repo);
    return { url: `https://github.com/${parsed.owner}/${parsed.repo}.git`, header: basicHeader('x-access-token', token), secret: token, revoke: { provider: 'github', token } };
  }
  const apiToken = await gitlabApiToken().catch(() => '');
  if (!apiToken) throw new BuildSourceError('GitLab builds need a connected GitLab token that can create project deploy tokens');
  const project = `${parsed.owner}/${parsed.repo}`;
  const res = await fetch(`${parsed.apiBase}/projects/${encodeURIComponent(project)}/deploy_tokens`, {
    method: 'POST', redirect: 'error',
    headers: { 'PRIVATE-TOKEN': apiToken, 'Content-Type': 'application/json', 'User-Agent': 'platform-api' },
    body: JSON.stringify({ name: `cairn-build-${buildId}`.slice(0, 64), scopes: ['read_repository'], expires_at: new Date(Date.now() + GITLAB_DEPLOY_TOKEN_TTL_MS).toISOString() }),
  });
  if (!res.ok) throw new BuildSourceError('GitLab did not issue a read-only deploy token for this project. The connected token needs Maintainer access and the api scope; builds do not fall back to broader credentials');
  const data: any = await res.json();
  if (!data?.token || !data?.username || !Number.isInteger(data?.id)) throw new BuildSourceError('GitLab returned no deploy token');
  return { url: `${gitlabOrigin()}/${project}.git`, header: basicHeader(String(data.username), String(data.token)), secret: String(data.token),
    revoke: { provider: 'gitlab', project, tokenId: data.id } };
}

export async function revokeCloneCredential(revoke: CloneRevocation | null | undefined): Promise<void> {
  if (!revoke) return;
  if (revoke.provider === 'github') return revokeInstallationToken(revoke.token);
  const apiToken = await gitlabApiToken().catch(() => '');
  if (!apiToken) return;
  const res = await fetch(`${gitlabOrigin()}/api/v4/projects/${encodeURIComponent(revoke.project)}/deploy_tokens/${revoke.tokenId}`, {
    method: 'DELETE', redirect: 'error', headers: { 'PRIVATE-TOKEN': apiToken, 'User-Agent': 'platform-api' },
  });
  if (!res.ok && res.status !== 404) throw new BuildSourceError(`GitLab deploy token revocation failed (${res.status})`);
}

const SHA = /^[a-f0-9]{40}$/;

/**
 * True only when `sha` is the head of `branch` in the project's linked repository, or an
 * ancestor of that head. Webhook payloads are not trusted for this: the provider is asked
 * directly, about the repository linked to the project (never the one named in the payload).
 */
export async function verifyCommitOnBranch(repositoryUrl: string, branch: string, sha: string): Promise<boolean> {
  if (!SHA.test(sha)) return false;
  const parsed = parseGitRemote(repositoryUrl);
  if (!parsed || parsed.provider === 'unknown') return false;
  if (parsed.provider === 'github') {
    const { token } = await mintScopedInstallationToken(parsed.owner, parsed.repo);
    try {
      const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'platform-api', 'X-GitHub-Api-Version': '2022-11-28' };
      const base = `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}`;
      const branchRes = await fetch(`${base}/branches/${encodeURIComponent(branch)}`, { headers, redirect: 'error' });
      if (!branchRes.ok) return false;
      const head = String((await branchRes.json() as any)?.commit?.sha || '');
      if (!SHA.test(head)) return false;
      if (head === sha) return true;
      const cmp = await fetch(`${base}/compare/${sha}...${head}`, { headers, redirect: 'error' });
      if (!cmp.ok) return false;
      const result: any = await cmp.json();
      return result?.status === 'ahead' && result?.merge_base_commit?.sha === sha;
    } finally {
      await revokeInstallationToken(token).catch(() => undefined);
    }
  }
  // GitLab has no repository-scoped API token equivalent; the connected token is used only
  // inside the API process for these two read calls and is never handed to a build.
  const apiToken = await gitlabApiToken().catch(() => '');
  if (!apiToken) return false;
  const headers = { 'PRIVATE-TOKEN': apiToken, 'User-Agent': 'platform-api' };
  const base = `${parsed.apiBase}/projects/${encodeURIComponent(`${parsed.owner}/${parsed.repo}`)}/repository`;
  const branchRes = await fetch(`${base}/branches/${encodeURIComponent(branch)}`, { headers, redirect: 'error' });
  if (!branchRes.ok) return false;
  const head = String((await branchRes.json() as any)?.commit?.id || '');
  if (!SHA.test(head)) return false;
  if (head === sha) return true;
  const mb = await fetch(`${base}/merge_base?refs[]=${sha}&refs[]=${head}`, { headers, redirect: 'error' });
  if (!mb.ok) return false;
  return String((await mb.json() as any)?.id || '') === sha;
}
