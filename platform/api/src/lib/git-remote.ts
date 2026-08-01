/** Parse GitHub / GitLab HTTPS or SSH clone URLs into API-friendly parts. */
export function parseGitRemote(repositoryUrl: string | null | undefined): {
  provider: 'github' | 'gitlab' | 'unknown';
  owner: string;
  repo: string;
  apiBase: string;
} | null {
  if (!repositoryUrl) return null;
  const cleaned = repositoryUrl.trim().replace(/\.git$/i, '');

  // git@github.com:owner/repo
  let m = cleaned.match(/^git@([^:]+):([^/]+)\/(.+)$/i);
  if (m) {
    const host = m[1].toLowerCase();
    const owner = m[2];
    const repo = m[3];
    if (host.includes('github')) {
      return { provider: 'github', owner, repo, apiBase: 'https://api.github.com' };
    }
    if (host.includes('gitlab')) {
      return { provider: 'gitlab', owner, repo, apiBase: `https://${host}/api/v4` };
    }
  }

  // https://github.com/owner/repo
  m = cleaned.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/#?]+)/i);
  if (m) {
    const host = m[1].toLowerCase();
    const owner = m[2];
    const repo = m[3];
    if (host.includes('github')) {
      return { provider: 'github', owner, repo, apiBase: 'https://api.github.com' };
    }
    if (host.includes('gitlab')) {
      return { provider: 'gitlab', owner, repo, apiBase: `https://${host}/api/v4` };
    }
  }

  return null;
}

export async function fetchRepoBranches(repositoryUrl: string): Promise<{
  defaultBranch: string;
  branches: { name: string; sha: string; protected?: boolean }[];
  provider: string;
  ownerRepo: string;
}> {
  const parsed = parseGitRemote(repositoryUrl);
  if (!parsed) throw new Error('Unsupported repository URL — use a GitHub or GitLab HTTPS/SSH URL');

  if (parsed.provider === 'github') {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'platform-api',
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const repoRes = await fetch(`${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}`, { headers });
    if (!repoRes.ok) {
      const body = await repoRes.text();
      throw new Error(`GitHub repo lookup failed (${repoRes.status}): ${body.slice(0, 200)}`);
    }
    const repoInfo: any = await repoRes.json();
    const defaultBranch = repoInfo.default_branch || 'main';

    const brRes = await fetch(
      `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}/branches?per_page=100`,
      { headers }
    );
    if (!brRes.ok) {
      const body = await brRes.text();
      throw new Error(`GitHub branches failed (${brRes.status}): ${body.slice(0, 200)}`);
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

    return {
      defaultBranch,
      branches,
      provider: 'github',
      ownerRepo: `${parsed.owner}/${parsed.repo}`,
    };
  }

  // GitLab
  {
    const headers: Record<string, string> = { 'User-Agent': 'platform-api' };
    if (process.env.GITLAB_TOKEN) {
      headers['PRIVATE-TOKEN'] = process.env.GITLAB_TOKEN;
    }
    const projectPath = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
    const projRes = await fetch(`${parsed.apiBase}/projects/${projectPath}`, { headers });
    if (!projRes.ok) {
      const body = await projRes.text();
      throw new Error(`GitLab project lookup failed (${projRes.status}): ${body.slice(0, 200)}`);
    }
    const proj: any = await projRes.json();
    const defaultBranch = proj.default_branch || 'main';
    const brRes = await fetch(
      `${parsed.apiBase}/projects/${projectPath}/repository/branches?per_page=100`,
      { headers }
    );
    if (!brRes.ok) {
      const body = await brRes.text();
      throw new Error(`GitLab branches failed (${brRes.status}): ${body.slice(0, 200)}`);
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
    return {
      defaultBranch,
      branches,
      provider: 'gitlab',
      ownerRepo: `${parsed.owner}/${parsed.repo}`,
    };
  }
}

export async function fetchBranchCommits(
  repositoryUrl: string,
  branch: string,
  limit = 20
): Promise<{ sha: string; message: string; author: string; date: string }[]> {
  const parsed = parseGitRemote(repositoryUrl);
  if (!parsed) throw new Error('Unsupported repository URL');

  if (parsed.provider === 'github') {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'platform-api',
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(
      `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`,
      { headers }
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

  const headers: Record<string, string> = { 'User-Agent': 'platform-api' };
  if (process.env.GITLAB_TOKEN) headers['PRIVATE-TOKEN'] = process.env.GITLAB_TOKEN;
  const projectPath = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
  const res = await fetch(
    `${parsed.apiBase}/projects/${projectPath}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=${limit}`,
    { headers }
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
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'platform-api',
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(
      `${parsed.apiBase}/repos/${parsed.owner}/${parsed.repo}/releases?per_page=${limit}`,
      { headers }
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
  const headers: Record<string, string> = { 'User-Agent': 'platform-api' };
  if (process.env.GITLAB_TOKEN) headers['PRIVATE-TOKEN'] = process.env.GITLAB_TOKEN;
  const projectPath = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
  const res = await fetch(
    `${parsed.apiBase}/projects/${projectPath}/releases?per_page=${limit}`,
    { headers }
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
