import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig } from './kube-config';
import { pullCredential } from './registry-token';

function clients() {
  const kc = new k8s.KubeConfig(); loadKubeConfig(kc);
  return { apps: kc.makeApiClient(k8s.AppsV1Api), core: kc.makeApiClient(k8s.CoreV1Api) };
}
const body = (r: any) => r.body || r;

export function sourceWorkload(namespace: string, name: string, image: string, projectId: string, environmentName: string) {
  const labels = { app: name, 'platform.io/project': projectId, 'platform.io/env': environmentName };
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace, labels }, spec: {
    replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels }, spec: {
      automountServiceAccountToken: false, imagePullSecrets: [{ name: 'source-registry' }],
      securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      // Always: the kubelet re-authorizes every pull with this namespace's credential, so an image
      // another project already cached on the node cannot be started by digest without access.
      containers: [{ name: 'app', image, imagePullPolicy: 'Always', ports: [{ containerPort: 8080 }], env: [{ name: 'PORT', value: '8080' }],
        readinessProbe: { tcpSocket: { port: 8080 }, initialDelaySeconds: 3, periodSeconds: 5 },
        resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } },
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
      }],
    } },
  } };
}

/**
 * Pull-only, per-project registry credential. The registry's token endpoint exchanges it for
 * short-lived tokens that can pull this project's repositories and nothing else.
 */
export async function sourcePullSecret(namespace: string, projectId: string) {
  const registry = process.env.BUILDS_REGISTRY || '';
  if (!/^[a-z0-9.-]+(?::[0-9]+)?$/.test(registry)) throw new Error('Build registry is not configured');
  const { username, password } = await pullCredential(projectId);
  const config = { auths: { [registry]: { username, password, auth: Buffer.from(`${username}:${password}`).toString('base64') } } };
  return { metadata: { name: 'source-registry', namespace }, type: 'kubernetes.io/dockerconfigjson',
    data: { '.dockerconfigjson': Buffer.from(JSON.stringify(config)).toString('base64') } };
}

/** Create or replace the namespace's pull Secret with the credential for the current signing key. */
export async function applySourcePullSecret(namespace: string, projectId: string): Promise<void> {
  const { core } = clients();
  const pullSecret = await sourcePullSecret(namespace, projectId);
  try { await core.createNamespacedSecret({ namespace, body: pullSecret }); }
  catch (e: any) {
    if ((e.code || e.statusCode) !== 409) throw e;
    const current = body(await core.readNamespacedSecret({ namespace, name: 'source-registry' }));
    await core.replaceNamespacedSecret({ namespace, name: 'source-registry', body: { ...pullSecret, metadata: { ...pullSecret.metadata, resourceVersion: current.metadata.resourceVersion } } });
  }
}

export async function applySourceWorkload(namespace: string, name: string, image: string, projectId: string, environmentName: string): Promise<void> {
  const { apps, core } = clients();
  await applySourcePullSecret(namespace, projectId);
  const desired: any = sourceWorkload(namespace, name, image, projectId, environmentName);
  try {
    const current = body(await apps.readNamespacedDeployment({ namespace, name }));
    if (current.metadata?.labels?.['platform.io/project'] !== projectId) throw new Error('Source deployment name is already in use');
    desired.metadata.resourceVersion = current.metadata.resourceVersion;
    await apps.replaceNamespacedDeployment({ namespace, name, body: desired });
  } catch (e: any) {
    if ((e.code || e.statusCode) !== 404) throw e;
    await apps.createNamespacedDeployment({ namespace, body: desired });
  }
  try { await core.readNamespacedService({ namespace, name }); }
  catch (e: any) {
    if ((e.code || e.statusCode) !== 404) throw e;
    await core.createNamespacedService({ namespace, body: { metadata: { name, namespace }, spec: { selector: { app: name }, ports: [{ port: 80, targetPort: 8080 }] } } });
  }
}

export async function sourceWorkloadReady(namespace: string, name: string): Promise<boolean> {
  const dep = body(await clients().apps.readNamespacedDeployment({ namespace, name }));
  return dep.status?.observedGeneration >= dep.metadata.generation && dep.status?.availableReplicas >= 1
    && dep.status?.updatedReplicas === dep.spec?.replicas && dep.status?.readyReplicas === dep.spec?.replicas
    && dep.status?.replicas === dep.spec?.replicas;
}
