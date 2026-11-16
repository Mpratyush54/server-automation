import { parseGitRemote } from './git-remote';
import { mintScopedInstallationToken, revokeInstallationToken } from './github-app';
import { gitlabApiToken } from './gitlab-app';
import { RepositorySource, repositoryApproved } from './repository-binding';

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

/** Mints a clone credential only for the project's current, administrator-approved repository. */
export async function mintCloneCredential(source: RepositorySource, buildId: string): Promise<CloneCredential> {
  if (!repositoryApproved(source)) throw new BuildSourceError('A platform administrator must approve this repository before it can be built');
  const parsed = parseGitRemote(source.repositoryUrl);
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
 * Where a pushed commit stands on the linked branch, as the provider reports it now:
 * - `head`: it is the branch head, so it may be built;
 * - `superseded`: it is an ancestor of the head (a newer commit exists), so it is skipped;
 * - `not-on-branch`: the provider definitely does not have it on that branch.
 */
export type BranchHeadCheck = 'head' | 'superseded' | 'not-on-branch';

/** The provider could not answer (unavailable, rate limited, no credential); the push may be retried. */
export class BuildProviderError extends Error {}

async function providerFetch(url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, { ...init, redirect: 'error' }); }
  catch { throw new BuildProviderError('Git provider unavailable'); }
}

function unavailable(res: Response): never { throw new BuildProviderError(`Git provider answered ${res.status}`); }

/**
 * Compares `sha` with the current head of `branch` in the project's linked repository. Webhook
 * payloads are not trusted for this: the provider is asked directly, about the repository linked
 * to the project (never the one named in the payload). Only definite answers are returned;
 * anything else throws BuildProviderError.
 */
export async function checkBranchHead(repositoryUrl: string, branch: string, sha: string): Promise<BranchHeadCheck> {
  if (!SHA.test(sha)) return 'not-on-branch';
  const parsed = parseGitRemote(repositoryUrl);
  if (!parsed || parsed.provider === 'unknown') return 'not-on-branch';
  if (parsed.provider === 'github') {
    let token: string;
    try { ({ token } = await mintScopedInstallationToken(parsed.owner, parsed.repo)); }
    catch { throw new BuildProviderError('GitHub App token unavailable'); }
    try {
      const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'platform-api', 'X-GitHub-Api-Version': '2022-11-28' };
      const base = `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}`;
      const branchRes = await providerFetch(`${base}/branches/${encodeURIComponent(branch)}`, { headers });
      if (branchRes.status === 404) return 'not-on-branch';
      if (!branchRes.ok) unavailable(branchRes);
      const head = String((await branchRes.json() as any)?.commit?.sha || '');
      if (!SHA.test(head)) throw new BuildProviderError('GitHub returned no branch head');
      if (head === sha) return 'head';
      const cmp = await providerFetch(`${base}/compare/${sha}...${head}`, { headers });
      if (cmp.status === 404) return 'not-on-branch';
      if (!cmp.ok) unavailable(cmp);
      const result: any = await cmp.json();
      return result?.status === 'ahead' && result?.merge_base_commit?.sha === sha ? 'superseded' : 'not-on-branch';
    } finally {
      await revokeInstallationToken(token).catch(() => undefined);
    }
  }
  // GitLab has no repository-scoped API token equivalent; the connected token is used only
  // inside the API process for these two read calls and is never handed to a build.
  const apiToken = await gitlabApiToken().catch(() => '');
  if (!apiToken) throw new BuildProviderError('GitLab token unavailable');
  const headers = { 'PRIVATE-TOKEN': apiToken, 'User-Agent': 'platform-api' };
  const base = `${parsed.apiBase}/projects/${encodeURIComponent(`${parsed.owner}/${parsed.repo}`)}/repository`;
  const branchRes = await providerFetch(`${base}/branches/${encodeURIComponent(branch)}`, { headers });
  if (branchRes.status === 404) return 'not-on-branch';
  if (!branchRes.ok) unavailable(branchRes);
  const head = String((await branchRes.json() as any)?.commit?.id || '');
  if (!SHA.test(head)) throw new BuildProviderError('GitLab returned no branch head');
  if (head === sha) return 'head';
  const mb = await providerFetch(`${base}/merge_base?refs[]=${sha}&refs[]=${head}`, { headers });
  // GitLab answers 400/404 when a ref is unknown to the repository.
  if (mb.status === 400 || mb.status === 404) return 'not-on-branch';
  if (!mb.ok) unavailable(mb);
  return String((await mb.json() as any)?.id || '') === sha ? 'superseded' : 'not-on-branch';
}
