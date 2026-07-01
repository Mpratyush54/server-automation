const GITLAB_API = process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4';
const TOKEN = process.env.GITLAB_TOKEN;

export async function triggerPipeline(projectId: string, branch: string): Promise<void> {
  if (!TOKEN) return;
  try {
    await fetch(`${GITLAB_API}/projects/${encodeURIComponent(projectId)}/trigger/pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, ref: branch }),
    });
  } catch {}
}

export async function getGitlabUser(gitlabId: string): Promise<any> {
  try {
    const res = await fetch(`${GITLAB_API}/users/${gitlabId}`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    return res.ok ? res.json() : null;
  } catch { return null; }
}
