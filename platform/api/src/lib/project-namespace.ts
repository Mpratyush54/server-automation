import { createHash } from 'crypto';
/** Server-owned K8s namespace for a project environment. Clients cannot choose this. */
export function projectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export function assignedNamespace(projectName: string, environmentName: string, projectId?: string): string {
  const slug = projectSlug(projectName);
  const env = String(environmentName || 'development')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '') || 'development';
  if (projectId) return `${slug.slice(0, 24)}-${env.slice(0, 16)}-${createHash('sha256').update(projectId).digest('hex').slice(0, 16)}`;
  return `${slug}-${env}`.slice(0, 63);
}

export function assignedEnvHost(projectName: string, environmentName: string, domain: string, projectId?: string): string {
  return `${assignedNamespace(projectName, environmentName, projectId)}.${domain}`;
}
