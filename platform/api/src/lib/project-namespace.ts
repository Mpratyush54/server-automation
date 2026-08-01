/** Server-owned K8s namespace for a project environment. Clients cannot choose this. */
export function projectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export function assignedNamespace(projectName: string, environmentName: string): string {
  const slug = projectSlug(projectName);
  const env = String(environmentName || 'development')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '') || 'development';
  return `${slug}-${env}`.slice(0, 63);
}

export function assignedEnvHost(projectName: string, environmentName: string, domain: string): string {
  return `${assignedNamespace(projectName, environmentName)}.${domain}`;
}
