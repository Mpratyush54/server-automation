const CLICKUP_API = 'https://api.clickup.com/api/v2';
const TOKEN = process.env.CLICKUP_API_TOKEN;

export async function postComment(taskId: string, comment: string): Promise<void> {
  await fetch(`${CLICKUP_API}/task/${taskId}/comment`, {
    method: 'POST',
    headers: { 'Authorization': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment_text: comment }),
  });
}

export async function formatPreviewComment(params: { project: string; branch: string; url: string; commit: string }): Promise<string> {
  return [
    `✅ Preview environment ready`,
    ``,
    `Project:     ${params.project}`,
    `Branch:      ${params.branch}`,
    `URL:         ${params.url}`,
    `Deployed at: ${new Date().toLocaleString()}`,
    `Expires:     72 hours after last push`,
    `Commit:      ${params.commit}`,
    ``,
    `Triggered by: git push`,
  ].join('\n');
}

export function extractTaskId(branch: string): string | null {
  const match = branch.match(/CU-(\d+)/i);
  return match ? `CU-${match[1]}` : null;
}

export function sanitizeBranch(branch: string): string {
  return branch
    .replace(/^(feature|fix|chore)\//i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
}
