import { createHash } from 'crypto';
import { baselineClients, ensureProjectNamespace, namespaceBaselineManifests, namespaceSettings, NamespaceEnvironment } from './namespace-baseline';

/** Conservative preflight; Kubernetes admission remains authoritative. No pod bodies/secrets in reports. */
export function podSecurityWarnings(pod: any): string[] {
  const spec = pod.spec || {};
  const warnings: string[] = [];
  if (spec.hostNetwork || spec.hostPID || spec.hostIPC) warnings.push('host namespace');
  if ((spec.volumes || []).some((v: any) => v.hostPath)) warnings.push('hostPath volume');
  for (const c of [...(spec.initContainers || []), ...(spec.containers || []), ...(spec.ephemeralContainers || [])]) {
    const ctx = c.securityContext || {};
    if (ctx.privileged) warnings.push(`${c.name}: privileged`);
    if (ctx.allowPrivilegeEscalation !== false) warnings.push(`${c.name}: allowPrivilegeEscalation must be false`);
    if (ctx.runAsNonRoot !== true && spec.securityContext?.runAsNonRoot !== true) warnings.push(`${c.name}: runAsNonRoot required`);
    if (ctx.runAsUser === 0 || spec.securityContext?.runAsUser === 0) warnings.push(`${c.name}: root user`);
    const seccomp = ctx.seccompProfile || spec.securityContext?.seccompProfile;
    if (!['RuntimeDefault', 'Localhost'].includes(seccomp?.type)) warnings.push(`${c.name}: seccomp profile required`);
    if (!ctx.capabilities?.drop?.includes('ALL') || (ctx.capabilities?.add || []).some((v: string) => v !== 'NET_BIND_SERVICE')) warnings.push(`${c.name}: restricted capabilities required`);
    if (!c.resources?.requests?.cpu || !c.resources?.requests?.memory || !c.resources?.limits?.cpu || !c.resources?.limits?.memory) warnings.push(`${c.name}: resource defaults apply only to new pods`);
  }
  return warnings;
}

export async function reportNamespaceBaseline(projectId: string, env: NamespaceEnvironment, clients = baselineClients()) {
  const desired = namespaceBaselineManifests(projectId, env, namespaceSettings(projectId, env.name), false);
  const ns = await clients.core.readNamespace({ name: env.namespace });
  const owner = ns.metadata?.labels?.['platform.io/project'];
  if (owner && owner !== projectId) throw new Error('Namespace belongs to another project');
  desired.namespace.metadata.labels['pod-security.kubernetes.io/enforce'] = ns.metadata?.labels?.['pod-security.kubernetes.io/enforce'] || 'privileged';
  const [pods, policies, quotas] = await Promise.all([
    clients.core.listNamespacedPod({ namespace: env.namespace }),
    clients.network.listNamespacedNetworkPolicy({ namespace: env.namespace }),
    clients.core.listNamespacedResourceQuota({ namespace: env.namespace }),
  ]);
  return { projectId, environment: env.name, namespace: env.namespace, desired,
    warnings: pods.items.map(p => ({ pod: p.metadata?.name, warnings: podSecurityWarnings(p) })).filter(p => p.warnings.length),
    existingPolicies: policies.items.map(p => p.metadata?.name),
    quotaUsage: quotas.items.map(q => ({ name: q.metadata?.name, hard: q.status?.hard, used: q.status?.used })),
    notes: ['Review application destinations against allow rules before applying; custom policies can widen access.', 'Shared legacy preview namespaces require a separate rolling migration; they are never relabeled.', 'Existing pods are not restarted. Review PSA warnings and quota headroom before replacement.'],
  };
}

export async function applyNamespaceBackfill(projectId: string, env: NamespaceEnvironment, enforceExisting = false) {
  return ensureProjectNamespace(projectId, env, { enforceExisting });
}

export function backfillFingerprint(rows: any[]): string {
  const configuration = rows.map(r => ({ projectId: r.projectId, namespace: r.namespace, desired: r.desired, existingPolicies: r.existingPolicies, error: r.error, skipped: r.skipped }))
    .sort((a, b) => `${a.projectId}/${a.namespace}`.localeCompare(`${b.projectId}/${b.namespace}`));
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

export function validateBackfillReport(rows: any[], reviewed: { fingerprint: string }, enforce: boolean): void {
  if (reviewed.fingerprint !== backfillFingerprint(rows)) throw new Error('Namespace configuration changed; generate and review a new dry-run report');
  if (rows.some(r => r.error)) throw new Error('Resolve namespace errors in the dry-run report before applying');
  if (enforce && rows.some(r => r.warnings?.length)) throw new Error('Resolve workload security/resource warnings before enforcing');
}
