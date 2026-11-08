/**
 * Load Kubernetes client configuration correctly in and out of a cluster.
 *
 * `KubeConfig.loadFromCluster()` does NOT throw outside a pod: it silently
 * builds a config for `https://undefined:undefined`. The previous pattern
 * `try { loadFromCluster() } catch { loadFromDefault() }` therefore never fell
 * back, and every Kubernetes call failed in local dev and host-side tools.
 * Decide from the environment Kubernetes injects into every pod instead.
 */
export interface LoadableKubeConfig {
  loadFromCluster(): void;
  loadFromDefault(): void;
}

export function inCluster(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.KUBERNETES_SERVICE_HOST && env.KUBERNETES_SERVICE_PORT);
}

/** Configure `kc` from the in-cluster ServiceAccount, else KUBECONFIG / ~/.kube/config. */
export function loadKubeConfig<T extends LoadableKubeConfig>(kc: T, env: NodeJS.ProcessEnv = process.env): T {
  if (inCluster(env)) {
    kc.loadFromCluster();
  } else {
    try {
      kc.loadFromDefault();
    } catch {
      // No config available: callers hit their own error handling.
    }
  }
  return kc;
}
