function gitlabApi(): string {
  return process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4';
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ref: branch }),
    });
  } catch {}
}

export async function getGitlabUser(gitlabId: string): Promise<any> {
  try {
    const res = await fetch(`${gitlabApi()}/users/${gitlabId}`, {
      headers: { 'Authorization': `Bearer ${gitlabToken()}` },
    });
    return res.ok ? res.json() : null;
  } catch { return null; }
}
