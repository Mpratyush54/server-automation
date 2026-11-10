import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig } from './kube-config';
import { releaseEnv } from './release-version';

/** Inject only in a project-owned dedicated namespace, with optimistic concurrency. */
export async function injectRelease(namespace: string, projectId: string, version: string): Promise<void> {
  const kc = new k8s.KubeConfig(); loadKubeConfig(kc);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const ns = await core.readNamespace({ name: namespace });
  if (ns.metadata?.labels?.['platform.io/project'] !== projectId) throw new Error('Release namespace ownership mismatch');
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const deployments = await apps.listNamespacedDeployment({ namespace });
  const statefulsets = await apps.listNamespacedStatefulSet({ namespace });
  const items = [...deployments.items.map(body => ({ body, stateful: false })), ...statefulsets.items.map(body => ({ body, stateful: true }))];
  if (!items.length) throw new Error('No supported release workloads in namespace');
  for (const { body, stateful } of items) {
    const spec = body.spec!.template.spec!;
    for (const container of [...spec.containers, ...(spec.initContainers || [])]) {
      const values = releaseEnv(version, container.env);
      container.env = [...(container.env || []).filter(e => !values.some(v => v.name === e.name)), ...values];
    }
    const args = { namespace, name: body.metadata!.name!, body };
    if (stateful) await apps.replaceNamespacedStatefulSet(args as any);
    else await apps.replaceNamespacedDeployment(args as any);
  }
  for (let attempt = 0; attempt < 36; attempt++) {
    let ready = true;
    for (const { body, stateful } of items) {
      const args = { namespace, name: body.metadata!.name! };
      const live = stateful ? await apps.readNamespacedStatefulSet(args) : await apps.readNamespacedDeployment(args);
      const status = live.status as any;
      const replicas = live.spec?.replicas ?? 1;
      if (!status || status.observedGeneration < (live.metadata?.generation || 0) ||
        (status.updatedReplicas || 0) !== replicas || (status.readyReplicas || 0) !== replicas) ready = false;
    }
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error('Release environment rollout timed out');
}
