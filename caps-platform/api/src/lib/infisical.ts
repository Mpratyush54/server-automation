const INFISICAL_API = 'https://app.infisical.com/api/v1';

export async function fetchSecrets(projectId: string, environment: string): Promise<Record<string, string>> {
  const token = process.env.INFISICAL_TOKEN;
  if (!token) return {};
  
  try {
    const res = await fetch(
      `${INFISICAL_API}/secrets?workspaceId=${projectId}&environment=${environment}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!res.ok) return {};
    const data = await res.json();
    const secrets: Record<string, string> = {};
    for (const secret of data.secrets || []) {
      secrets[secret.secretKey] = secret.secretValue;
    }
    return secrets;
  } catch { return {}; }
}
