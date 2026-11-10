import { parseGitRemote } from './git-remote';

function remoteHeaders(provider: string, smart = false): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'platform-api' };
  if (provider === 'github') {
    if (!smart) headers.Accept = 'application/vnd.github+json';
    if (process.env.GITHUB_TOKEN) headers.Authorization = smart
      ? `Basic ${Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64')}`
      : `Bearer ${process.env.GITHUB_TOKEN}`;
  } else if (process.env.GITLAB_TOKEN) {
    if (smart) headers.Authorization = `Basic ${Buffer.from(`oauth2:${process.env.GITLAB_TOKEN}`).toString('base64')}`;
    else headers['PRIVATE-TOKEN'] = process.env.GITLAB_TOKEN;
  }
  return headers;
}

/** Only configured provider origins are contacted; redirects never forward credentials. */
export async function resolveDefaultBranch(repoUrl: string): Promise<string> {
  const remote = parseGitRemote(repoUrl);
  if (!remote) return 'HEAD';
  try {
    const endpoint = remote.provider === 'github'
      ? `${remote.apiBase}/repos/${remote.owner}/${remote.repo}`
      : `${remote.apiBase}/projects/${encodeURIComponent(`${remote.owner}/${remote.repo}`)}`;
    const response = await fetch(endpoint, {
      headers: remoteHeaders(remote.provider), redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data: any = await response.json();
      if (typeof data.default_branch === 'string' && data.default_branch.trim()) return data.default_branch;
    }
  } catch { /* Provider unavailable: try Git protocol v0's HEAD symref. */ }
  try {
    const origin = remote.provider === 'github' ? 'https://github.com' : new URL(remote.apiBase).origin;
    const response = await fetch(`${origin}/${remote.owner}/${remote.repo}.git/info/refs?service=git-upload-pack`, {
      headers: remoteHeaders(remote.provider, true), redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      // v0 advertisement: <oid> HEAD\0... symref=HEAD:refs/heads/<branch> ...
      const advertisement = await response.text();
      const match = advertisement.match(/(?:^|[\0\s])symref=HEAD:refs\/heads\/([^\s\0]+)/);
      if (match) return match[1];
    }
  } catch { /* Argo can resolve HEAD itself when discovery is unavailable. */ }
  return 'HEAD';
}

export async function repositoryHasBranch(repoUrl: string, branch: string): Promise<boolean | undefined> {
  const remote = parseGitRemote(repoUrl);
  if (!remote) return undefined;
  const endpoint = remote.provider === 'github'
    ? `${remote.apiBase}/repos/${remote.owner}/${remote.repo}/branches/${encodeURIComponent(branch)}`
    : `${remote.apiBase}/projects/${encodeURIComponent(`${remote.owner}/${remote.repo}`)}/repository/branches/${encodeURIComponent(branch)}`;
  try {
    const response = await fetch(endpoint, {
      headers: remoteHeaders(remote.provider), redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return true;
    if (response.status === 404) return false;
  } catch { /* Unknown: do not migrate. */ }
  return undefined;
}
