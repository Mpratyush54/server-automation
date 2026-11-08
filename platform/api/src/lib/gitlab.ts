function gitlabApi(): string {
  const origin = new URL(process.env.GITLAB_URL || 'https://gitlab.com');
  const api = new URL(process.env.GITLAB_API_URL || `${origin.origin}/api/v4`);
  if (origin.protocol !== 'https:' || api.origin !== origin.origin || api.username || api.password || api.search || api.hash) {
    throw new Error('GitLab API must use the configured HTTPS GitLab origin');
  }
  return api.toString().replace(/\/$/, '');
}

function gitlabToken(): string | undefined {
  return process.env.GITLAB_TOKEN;
}

export async function triggerPipeline(projectId: string, branch: string): Promise<void> {
  const token = gitlabToken();
  if (!token) return;
  try {
    await fetch(`${gitlabApi()}/projects/${encodeURIComponent(projectId)}/trigger/pipeline`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ref: branch }),
    });
  } catch {}
}

export async function getGitlabUser(gitlabId: string): Promise<any> {
  try {
    const res = await fetch(`${gitlabApi()}/users/${encodeURIComponent(gitlabId)}`, {
      redirect: 'error',
      headers: { 'Authorization': `Bearer ${gitlabToken()}` },
    });
    return res.ok ? res.json() : null;
  } catch { return null; }
}
