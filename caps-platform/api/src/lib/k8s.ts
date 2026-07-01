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
      metadata: { name: deploymentName, namespace: 'preview', labels: { app: deploymentName, branch: sanitized } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: deploymentName } },
        template: {
          metadata: { labels: { app: deploymentName } },
          spec: {
            containers: [{
              name: 'web',
              image: `registry.gitlab.com/caps/${projectName}:${imageTag}`,
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
      // already exists
    }

    console.log(`[k8s] Preview deployed: ${deploymentName} → ${domain}`);
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
// ArgoCD Application update (uses CustomObjectsApi)
// ──────────────────────────────────────────────────────────────────────────────
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
    const spec = app.spec || {};

    if (spec.source?.helm?.parameters) {
      const param = spec.source.helm.parameters.find((p: any) => p.name === 'image.tag');
      if (param) param.value = imageTag;
      else spec.source.helm.parameters.push({ name: 'image.tag', value: imageTag });
    }

    await customApi.patchNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: 'argocd',
      plural: 'applications',
      name: appName,
      body: { spec },
    });

    await customApi.patchNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: 'argocd',
      plural: 'applications',
      name: appName,
      body: {
        spec: {
          ...spec,
          operation: {
            initiatedBy: { username: 'caps-platform' },
            sync: { syncStrategy: { hook: {} } },
          },
        },
      },
    });

    return true;
  } catch (err: any) {
    console.error(`[argo] updateArgoCDApp failed for ${appName}:`, err.message);
    return false;
  }
}
