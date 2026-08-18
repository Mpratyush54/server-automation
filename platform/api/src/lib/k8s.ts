import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';

// ── Kubernetes client (in-cluster when running in a pod, local kubeconfig otherwise) ──
function makeKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();          // works inside a K8s pod with a mounted ServiceAccount
  } catch {
    try {
      kc.loadFromDefault();        // falls back to ~/.kube/config for local dev
    } catch {
      // no config available – callers will hit their own error handling
    }
  }
  return kc;
}

const kc = makeKubeConfig();
const coreApi  = kc.makeApiClient(k8s.CoreV1Api);
const appsApi  = kc.makeApiClient(k8s.AppsV1Api);

// ──────────────────────────────────────────────────────────────────────────────
// Connection check
// ──────────────────────────────────────────────────────────────────────────────
export async function checkK8sConnection(): Promise<boolean> {
  try {
    await coreApi.listNamespace();
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Nodes
// ──────────────────────────────────────────────────────────────────────────────
export async function getK8sNodes(): Promise<any[]> {
  try {
    const res = await coreApi.listNode();
    return (res.items || []).map((node: any) => {
      const addresses = node.status?.addresses || [];
      const internalIp = addresses.find((a: any) => a.type === 'InternalIP')?.address || '—';
      const isControlPlane = Object.keys(node.metadata?.labels || {}).some(
        (l) => l.includes('control-plane') || l.includes('master')
      );
      const readyCond = node.status?.conditions?.find((c: any) => c.type === 'Ready');
      return {
        name: node.metadata?.name,
        ip: internalIp,
        role: isControlPlane ? 'master' : 'worker',
        status: readyCond?.status === 'True' ? 'Ready' : 'NotReady',
        cpu: `${node.status?.allocatable?.cpu || '?'} Core`,
        memory: node.status?.allocatable?.memory || '?',
      };
    });
  } catch (err: any) {
    console.warn(`[k8s] getK8sNodes failed: ${err.message}`);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Namespaces
// ──────────────────────────────────────────────────────────────────────────────
export async function getK8sNamespaces(): Promise<any[]> {
  try {
    const res = await coreApi.listNamespace();
    return (res.items || []).map((ns: any) => {
      const created = new Date(ns.metadata?.creationTimestamp);
      const ageDays = Math.floor((Date.now() - created.getTime()) / 86_400_000);
      return {
        name: ns.metadata?.name,
        status: ns.status?.phase || 'Active',
        age: `${ageDays}d`,
      };
    });
  } catch (err: any) {
    console.warn(`[k8s] getK8sNamespaces failed: ${err.message}`);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Pods
// ──────────────────────────────────────────────────────────────────────────────
export async function getK8sPods(namespace?: string): Promise<any[]> {
  try {
    const res = namespace
      ? await coreApi.listNamespacedPod({ namespace })
      : await coreApi.listPodForAllNamespaces();

    return (res.items || []).map((pod: any) => {
      const containerStatuses = pod.status?.containerStatuses || [];
      const restarts = containerStatuses.reduce(
        (acc: number, c: any) => acc + (c.restartCount || 0),
        0
      );
      const created = new Date(pod.metadata?.creationTimestamp);
      const diffMs = Date.now() - created.getTime();
      const h = Math.floor(diffMs / 3_600_000);
      const m = Math.floor((diffMs % 3_600_000) / 60_000);
      return {
        name: pod.metadata?.name,
        namespace: pod.metadata?.namespace,
        status: pod.status?.phase,
        restarts,
        age: h > 0 ? `${h}h ${m}m` : `${m}m`,
        node: pod.spec?.nodeName || '—',
      };
    });
  } catch (err: any) {
    console.warn(`[k8s] getK8sPods failed: ${err.message}`);
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Pod logs
// ──────────────────────────────────────────────────────────────────────────────
export async function getPodLogs(namespace: string, podName: string): Promise<string> {
  try {
    const res = await coreApi.readNamespacedPodLog({
      name: podName,
      namespace,
      tailLines: 100,
    });
    return res;
  } catch (err: any) {
    console.warn(`[k8s] getPodLogs failed for ${podName}: ${err.message}`);
    return `Failed to fetch logs: ${err.message}`;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Delete pod
// ──────────────────────────────────────────────────────────────────────────────
export async function deletePod(namespace: string, podName: string): Promise<boolean> {
  try {
    await coreApi.deleteNamespacedPod({ name: podName, namespace });
    return true;
  } catch (err: any) {
    console.warn(`[k8s] deletePod failed: ${err.message}`);
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Preview deployments (branch preview environments)
// ──────────────────────────────────────────────────────────────────────────────
export async function deployK8sPreview(
  projectName: string,
  branch: string,
  imageTag: string
): Promise<boolean> {
  const sanitized = branch
    .replace(/^(feature|fix|chore)\//i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');

  const deploymentName = `preview-${sanitized}`;
  const projectSlug = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
  const baseDomain = process.env.DOMAIN || 'sslip.io';
  const domain = `${projectSlug}-${sanitized}.preview.${baseDomain}`;
  // Allow full image refs (nginx:alpine, ghcr.io/org/app:tag); otherwise GitLab registry convention.
  const image =
    imageTag.includes('/') || imageTag.includes(':')
      ? imageTag
      : `registry.gitlab.com/platform/${projectName}:${imageTag}`;

  try {
    // Ensure preview namespace exists
    try {
      await coreApi.createNamespace({
        body: { metadata: { name: 'preview' } },
      });
    } catch {
      // Namespace already exists — ignore
    }

    // Create/patch Deployment
    const deployment: k8s.V1Deployment = {
      metadata: { name: deploymentName, namespace: 'preview', labels: { app: deploymentName, branch: sanitized, project: projectSlug } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: deploymentName } },
        template: {
          metadata: { labels: { app: deploymentName } },
          spec: {
            containers: [{
              name: 'web',
              image,
              ports: [{ containerPort: 80 }],
            }],
          },
        },
      },
    };

    try {
      await appsApi.createNamespacedDeployment({ namespace: 'preview', body: deployment });
    } catch {
      await appsApi.replaceNamespacedDeployment({ name: deploymentName, namespace: 'preview', body: deployment });
    }

    // Create/patch Service
    const svc: k8s.V1Service = {
      metadata: { name: deploymentName, namespace: 'preview' },
      spec: {
        selector: { app: deploymentName },
        ports: [{ port: 80, targetPort: 80 as any }],
      },
    };
    try {
      await coreApi.createNamespacedService({ namespace: 'preview', body: svc });
    } catch {
      // already exists — patch selector/ports
      try {
        await coreApi.replaceNamespacedService({ name: deploymentName, namespace: 'preview', body: svc });
      } catch {
        // ignore
      }
    }

    // Ingress so the preview URL is reachable
    const networkApi = kc.makeApiClient(k8s.NetworkingV1Api);
    const ingress: k8s.V1Ingress = {
      metadata: {
        name: deploymentName,
        namespace: 'preview',
        annotations: {
          'kubernetes.io/ingress.class': 'nginx',
          'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
        },
      },
      spec: {
        ingressClassName: 'nginx',
        tls: [{ hosts: [domain], secretName: `${deploymentName}-tls` }],
        rules: [{
          host: domain,
          http: {
            paths: [{
              path: '/',
              pathType: 'Prefix',
              backend: { service: { name: deploymentName, port: { number: 80 } } },
            }],
          },
        }],
      },
    };
    try {
      await networkApi.createNamespacedIngress({ namespace: 'preview', body: ingress });
    } catch {
      try {
        await networkApi.replaceNamespacedIngress({ name: deploymentName, namespace: 'preview', body: ingress });
      } catch (e: any) {
        console.warn(`[k8s] preview ingress: ${e.message}`);
      }
    }

    console.log(`[k8s] Preview deployed: ${deploymentName} → https://${domain} (image=${image})`);
    return true;
  } catch (err: any) {
    console.warn(`[k8s] deployK8sPreview failed: ${err.message}`);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Terminate preview
// ──────────────────────────────────────────────────────────────────────────────
export async function terminateK8sPreview(branch: string): Promise<boolean> {
  const sanitized = branch
    .replace(/^(feature|fix|chore)\//i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');

  const deploymentName = `preview-${sanitized}`;
  try {
    await appsApi.deleteNamespacedDeployment({ name: deploymentName, namespace: 'preview' }).catch(() => {});
    await coreApi.deleteNamespacedService({ name: deploymentName, namespace: 'preview' }).catch(() => {});
    console.log(`[k8s] Preview terminated: ${deploymentName}`);
    return true;
  } catch (err: any) {
    console.warn(`[k8s] terminateK8sPreview failed: ${err.message}`);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ArgoCD Application create / update / sync (Git pull path)
// ──────────────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export function argoAppName(projectName: string, envName: string): string {
  return `${slugify(projectName)}-${slugify(envName)}`.slice(0, 63);
}

/**
 * Ensure an Ingress exists for a project service host with Let's Encrypt TLS
 * (including *.sslip.io — HTTP-01 works for individual FQDNs).
 */
export async function ensureProjectIngress(opts: {
  name: string;
  namespace: string;
  host: string;
  serviceName: string;
  servicePort?: number;
}): Promise<{ ok: boolean; host: string; error?: string }> {
  const { name, namespace, host, serviceName, servicePort = 80 } = opts;
  if (!host || host.includes('example.com')) {
    return { ok: false, host, error: 'No real host configured — set project domain first' };
  }

  const secretName = `${slugify(name)}-tls`.slice(0, 63);
  const ingressName = slugify(name).slice(0, 63);
  const networkApi = kc.makeApiClient(k8s.NetworkingV1Api);

  try {
    await coreApi.createNamespace({ body: { metadata: { name: namespace } } as any });
  } catch {
    // already exists
  }

  const ingress: k8s.V1Ingress = {
    metadata: {
      name: ingressName,
      namespace,
      annotations: {
        'kubernetes.io/ingress.class': 'nginx',
        'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
        'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
      },
      labels: {
        'app.kubernetes.io/managed-by': 'platform',
      },
    },
    spec: {
      ingressClassName: 'nginx',
      tls: [{ hosts: [host], secretName }],
      rules: [{
        host,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: { service: { name: serviceName, port: { number: servicePort } } },
          }],
        },
      }],
    },
  };

  try {
    try {
      await networkApi.createNamespacedIngress({ namespace, body: ingress });
    } catch {
      try {
        const existing: any = await networkApi.readNamespacedIngress({
          name: ingressName,
          namespace,
        });
        const body = existing.body || existing;
        ingress.metadata!.resourceVersion = body.metadata?.resourceVersion;
        await networkApi.replaceNamespacedIngress({
          name: ingressName,
          namespace,
          body: ingress,
        });
      } catch (replaceErr: any) {
        console.warn(`[k8s] ingress replace failed for ${host}:`, replaceErr.message);
        throw replaceErr;
      }
    }
    console.log(`[k8s] Ingress ready: https://${host} → ${namespace}/${serviceName}`);
    return { ok: true, host };
  } catch (err: any) {
    console.error(`[k8s] ensureProjectIngress failed for ${host}:`, err.message);
    return { ok: false, host, error: err.message };
  }
}

export async function ensureAndSyncArgoApp(opts: {
  appName: string;
  repoURL: string;
  path?: string;
  targetRevision: string;
  namespace: string;
  imageTag?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const {
    appName,
    repoURL,
    path = 'k8s',
    targetRevision,
    namespace,
    imageTag,
  } = opts;

  if (!repoURL) {
    return { ok: false, error: 'Project has no repositoryUrl — set a GitHub/GitLab URL to pull & deploy' };
  }

  try {
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    let app: any = null;

    try {
      const existing: any = await customApi.getNamespacedCustomObject({
        group: 'argoproj.io',
        version: 'v1alpha1',
        namespace: 'argocd',
        plural: 'applications',
        name: appName,
      });
      app = existing.body || existing;
    } catch {
      app = null;
    }

    const application = {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: {
        name: appName,
        namespace: 'argocd',
        labels: {
          'app.kubernetes.io/managed-by': 'platform',
        },
        ...(app?.metadata?.resourceVersion
          ? { resourceVersion: app.metadata.resourceVersion }
          : {}),
      },
      spec: {
        project: 'default',
        source: {
          repoURL,
          targetRevision: targetRevision || 'HEAD',
          path,
          ...(imageTag && app?.spec?.source?.helm
            ? {
                helm: {
                  ...(app.spec.source.helm || {}),
                  parameters: [
                    ...((app.spec.source.helm?.parameters || []).filter(
                      (p: any) => p.name !== 'image.tag'
                    )),
                    { name: 'image.tag', value: imageTag },
                  ],
                },
              }
            : {}),
        },
        destination: {
          server: 'https://kubernetes.default.svc',
          namespace,
        },
        syncPolicy: {
          automated: { prune: true, selfHeal: true },
          syncOptions: ['CreateNamespace=true'],
        },
      },
    };

    if (app) {
      await customApi.replaceNamespacedCustomObject({
        group: 'argoproj.io',
        version: 'v1alpha1',
        namespace: 'argocd',
        plural: 'applications',
        name: appName,
        body: application as any,
      });
    } else {
      await customApi.createNamespacedCustomObject({
        group: 'argoproj.io',
        version: 'v1alpha1',
        namespace: 'argocd',
        plural: 'applications',
        body: application as any,
      });
    }

    // Trigger an explicit sync
    try {
      await customApi.patchNamespacedCustomObject({
        group: 'argoproj.io',
        version: 'v1alpha1',
        namespace: 'argocd',
        plural: 'applications',
        name: appName,
        body: {
          operation: {
            initiatedBy: { username: 'platform-ui' },
            sync: {
              revision: targetRevision || 'HEAD',
              syncStrategy: { apply: { force: false } },
            },
          },
        },
      } as any);
    } catch (syncErr: any) {
      console.warn(`[argo] sync trigger warning for ${appName}:`, syncErr.message);
    }

    return { ok: true };
  } catch (err: any) {
    console.error(`[argo] ensureAndSyncArgoApp failed for ${appName}:`, err.message);
    return { ok: false, error: err.message };
  }
}

/** @deprecated prefer ensureAndSyncArgoApp — kept for callers that only bump image.tag */
export async function updateArgoCDApp(appName: string, imageTag: string): Promise<boolean> {
  try {
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const appResponse: any = await customApi.getNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: 'argocd',
      plural: 'applications',
      name: appName,
    });
    const app = appResponse.body || appResponse;
    const repoURL = app?.spec?.source?.repoURL;
    const path = app?.spec?.source?.path || 'k8s';
    const revision = app?.spec?.source?.targetRevision || 'HEAD';
    const namespace = app?.spec?.destination?.namespace || 'default';
    if (!repoURL) return false;
    const result = await ensureAndSyncArgoApp({
      appName,
      repoURL,
      path,
      targetRevision: revision,
      namespace,
      imageTag,
    });
    return result.ok;
  } catch (err: any) {
    console.error(`[argo] updateArgoCDApp failed for ${appName}:`, err.message);
    return false;
  }
}

export async function patchSecretData(namespace: string, name: string, data: Record<string, string>): Promise<void> {
  const existing: any = await coreApi.readNamespacedSecret({ name, namespace });
  const secret = existing.body || existing;
  secret.data = secret.data || {};
  for (const [k, v] of Object.entries(data)) {
    secret.data[k] = Buffer.from(v, 'utf8').toString('base64');
  }
  await coreApi.replaceNamespacedSecret({ name, namespace, body: secret });
}

export async function restartNamedDeployment(namespace: string, name: string): Promise<void> {
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
          },
        },
      },
    },
  };
  await appsApi.patchNamespacedDeployment({
    name,
    namespace,
    body: patch,
  });
}

