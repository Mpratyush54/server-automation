import { githubAuthorizationFor } from './github-app';
import { gitlabApiToken } from './gitlab-app';
import { redisKey, stateBackend, withRedis } from './redis';

/**
 * GitHub API headers for `owner/repo`: a GitHub App installation token when the App is
 * installed on the repository (#35), else the legacy GITHUB_TOKEN, else anonymous.
 */
async function githubHeaders(owner: string, repo: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'platform-api',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const auth = await githubAuthorizationFor(owner, repo);
  if (auth) headers.Authorization = auth;
  return headers;
}

/** GitLab API headers: the kept connect token (#35) or GITLAB_TOKEN, else anonymous. */
async function gitlabHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'User-Agent': 'platform-api' };
  const token = await gitlabApiToken().catch(() => process.env.GITLAB_TOKEN || '');
  if (token) headers['PRIVATE-TOKEN'] = token;
  return headers;
}

/** How long a successful branch list is reused before re-hitting the provider (#155). */
export const BRANCH_CACHE_TTL_MS = 60_000;

export type RepoBranches = {
  defaultBranch: string;
  branches: { name: string; sha: string; protected?: boolean }[];
  provider: string;
  ownerRepo: string;
};

// Memory backend only under tests / PLATFORM_STATE_STORE=memory (single replica); deployments
// use Redis. Bounded: at most MEMORY_BRANCH_CACHE_MAX repositories, oldest evicted first.
const MEMORY_BRANCH_CACHE_MAX = 200;
const memoryBranchCache: Record<string, { expiresAt: number; value: RepoBranches }> = {};

function branchCacheKey(provider: string, ownerRepo: string): string {
  return `git-branches:${provider}:${ownerRepo.toLowerCase()}`;
}

async function readBranchCache(key: string): Promise<RepoBranches | null> {
  if (stateBackend() === 'redis') {
    try {
      const raw = await withRedis((r) => r.get(redisKey(key)));
      if (!raw) return null;
      return JSON.parse(raw) as RepoBranches;
    } catch {
      return null;
    }
  }
  const entry = memoryBranchCache[key];
  if (!entry || entry.expiresAt <= Date.now()) {
    delete memoryBranchCache[key];
    return null;
  }
  return entry.value;
}

async function writeBranchCache(key: string, value: RepoBranches): Promise<void> {
  if (stateBackend() === 'redis') {
    try {
      await withRedis((r) => r.set(redisKey(key), JSON.stringify(value), 'PX', BRANCH_CACHE_TTL_MS));
    } catch {
      /* cache is best-effort */
    }
    return;
  }
  delete memoryBranchCache[key];
  const keys = Object.keys(memoryBranchCache);
  for (let i = 0; i <= keys.length - MEMORY_BRANCH_CACHE_MAX; i++) delete memoryBranchCache[keys[i]];
  memoryBranchCache[key] = { expiresAt: Date.now() + BRANCH_CACHE_TTL_MS, value };
}

/** Test hook: drop in-memory branch lists. */
export function clearBranchCacheForTests(): void {
  for (const k of Object.keys(memoryBranchCache)) delete memoryBranchCache[k];
}

function rateLimitError(provider: string, status: number, body: string): Error {
  const snippet = body.slice(0, 200);
  if (status === 403 && /rate.?limit|secondary rate/i.test(body)) {
    return new Error(
      `${provider} API rate limit exceeded (${status}). Connect a GitHub App installation or set GITHUB_TOKEN. ${snippet}`,
    );
  }
  return new Error(`${provider} request failed (${status}): ${snippet}`);
}

/** Only configured provider origins may receive platform credentials. */
export function parseGitRemote(repositoryUrl: string | null | undefined): {
  provider: 'github' | 'gitlab' | 'unknown'; owner: string; repo: string; apiBase: string;
} | null {
  if (!repositoryUrl) return null;
  try {
    const input = repositoryUrl.trim().replace(/^git@([^:]+):/, 'https://$1/');
    const url = new URL(input);
    const gitlab = new URL(process.env.GITLAB_URL || 'https://gitlab.com');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length < 2 || parts.some(p => !/^[a-zA-Z0-9_.-]+$/.test(p))) return null;
    const repo = parts.pop()!;
    const owner = parts.join('/');
    if (url.origin === 'https://github.com' && parts.length === 1) {
      return { provider: 'github', owner, repo, apiBase: 'https://api.github.com' };
    }
    if (gitlab.protocol === 'https:' && url.origin === gitlab.origin) {
      return { provider: 'gitlab', owner, repo, apiBase: `${gitlab.origin}/api/v4` };
    }
    return null;
  } catch { return null; }
}

export async function fetchRepoBranches(repositoryUrl: string): Promise<RepoBranches> {
  const parsed = parseGitRemote(repositoryUrl);
  if (!parsed) throw new Error('Unsupported repository URL — use a GitHub or GitLab HTTPS/SSH URL');

  const ownerRepo = `${parsed.owner}/${parsed.repo}`;
  const cacheKey = branchCacheKey(parsed.provider, ownerRepo);
  const cached = await readBranchCache(cacheKey);
  if (cached) return cached;

  let result: RepoBranches;

  if (parsed.provider === 'github') {
    const headers = await githubHeaders(parsed.owner, parsed.repo);

    const repoRes = await fetch(`${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}`, { headers, redirect: 'error' });
    if (!repoRes.ok) {
      const body = await repoRes.text();
      throw rateLimitError('GitHub repo lookup', repoRes.status, body);
    }
    const repoInfo: any = await repoRes.json();
    const defaultBranch = repoInfo.default_branch || 'HEAD';

    const brRes = await fetch(
      `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}/branches?per_page=100`,
      { headers, redirect: 'error' }
    );
    if (!brRes.ok) {
      const body = await brRes.text();
      throw rateLimitError('GitHub branches', brRes.status, body);
    }
    const branchesRaw: any[] = await brRes.json();
    const branches = branchesRaw.map((b) => ({
      name: b.name as string,
      sha: (b.commit?.sha || '').slice(0, 40),
      protected: !!b.protected,
    }));

    // Ensure default branch is first
    branches.sort((a, b) => {
      if (a.name === defaultBranch) return -1;
      if (b.name === defaultBranch) return 1;
      return a.name.localeCompare(b.name);
    });

    result = {
      defaultBranch,
      branches,
      provider: 'github',
      ownerRepo,
    };
  } else {
    // GitLab
    const headers = await gitlabHeaders();
    const projectPath = encodeURIComponent(ownerRepo);
    const projRes = await fetch(`${parsed.apiBase}/projects/${projectPath}`, { headers, redirect: 'error' });
    if (!projRes.ok) {
      const body = await projRes.text();
      throw rateLimitError('GitLab project lookup', projRes.status, body);
    }
    const proj: any = await projRes.json();
    const defaultBranch = proj.default_branch || 'HEAD';
    const brRes = await fetch(
      `${parsed.apiBase}/projects/${projectPath}/repository/branches?per_page=100`,
      { headers, redirect: 'error' }
    );
    if (!brRes.ok) {
      const body = await brRes.text();
      throw rateLimitError('GitLab branches', brRes.status, body);
    }
    const branchesRaw: any[] = await brRes.json();
    const branches = branchesRaw.map((b) => ({
      name: b.name as string,
      sha: (b.commit?.id || '').slice(0, 40),
      protected: !!b.protected,
    }));
    branches.sort((a, b) => {
      if (a.name === defaultBranch) return -1;
      if (b.name === defaultBranch) return 1;
      return a.name.localeCompare(b.name);
    });
    result = {
      defaultBranch,
      branches,
      provider: 'gitlab',
      ownerRepo,
    };
  }

  await writeBranchCache(cacheKey, result);
  return result;
}

export async function fetchBranchCommits(
  repositoryUrl: string,
  branch: string,
  limit = 20
): Promise<{ sha: string; message: string; author: string; date: string }[]> {
  const parsed = parseGitRemote(repositoryUrl);
  if (!parsed) throw new Error('Unsupported repository URL');

  if (parsed.provider === 'github') {
    const headers = await githubHeaders(parsed.owner, parsed.repo);
    const res = await fetch(
      `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`,
      { headers, redirect: 'error' }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub commits failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const rows: any[] = await res.json();
    return rows.map((c) => ({
      sha: c.sha as string,
      message: (c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name || c.author?.login || 'unknown',
      date: c.commit?.author?.date || '',
    }));
  }

  const headers = await gitlabHeaders();
  const projectPath = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
  const res = await fetch(
    `${parsed.apiBase}/projects/${projectPath}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=${limit}`,
    { headers, redirect: 'error' }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitLab commits failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const rows: any[] = await res.json();
  return rows.map((c) => ({
    sha: c.id as string,
    message: (c.title || c.message || '').split('\n')[0],
    author: c.author_name || 'unknown',
    date: c.authored_date || c.created_at || '',
  }));
}

export async function fetchRepoReleases(
  repositoryUrl: string,
  limit = 10
): Promise<{
  tag: string;
  name: string;
  sha: string;
  prerelease: boolean;
  draft: boolean;
  publishedAt: string;
  htmlUrl: string;
  body: string;
}[]> {
  const parsed = parseGitRemote(repositoryUrl);
  if (!parsed) throw new Error('Unsupported repository URL');

  if (parsed.provider === 'github') {
    const headers = await githubHeaders(parsed.owner, parsed.repo);
    const res = await fetch(
      `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}/releases?per_page=${limit}`,
      { headers, redirect: 'error' }
    );
    if (!res.ok) {
      // 404 = no releases yet — not an error for the UI
      if (res.status === 404) return [];
      const body = await res.text();
      throw new Error(`GitHub releases failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const rows: any[] = await res.json();
    return rows
      .filter((r) => !r.draft)
      .map((r) => ({
        tag: r.tag_name as string,
        name: (r.name || r.tag_name) as string,
        sha: '', // filled below when possible
        prerelease: !!r.prerelease,
        draft: !!r.draft,
        publishedAt: r.published_at || r.created_at || '',
        htmlUrl: r.html_url || '',
        body: (r.body || '').slice(0, 500),
      }));
  }

  // GitLab releases
  const headers = await gitlabHeaders();
  const projectPath = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
  const res = await fetch(
    `${parsed.apiBase}/projects/${projectPath}/releases?per_page=${limit}`,
    { headers, redirect: 'error' }
  );
  if (!res.ok) {
    if (res.status === 404) return [];
    const body = await res.text();
    throw new Error(`GitLab releases failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const rows: any[] = await res.json();
  return rows.map((r) => ({
    tag: r.tag_name as string,
    name: (r.name || r.tag_name) as string,
    sha: r.commit?.id || '',
    prerelease: false,
    draft: false,
    publishedAt: r.released_at || r.created_at || '',
    htmlUrl: r._links?.self || '',
    body: (r.description || '').slice(0, 500),
  }));
}

export { resolveDefaultBranch } from './git-default-branch';
