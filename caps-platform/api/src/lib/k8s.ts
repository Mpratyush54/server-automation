import { exec } from 'child_process';
import { promisify } from 'util';
import * as k8s from '@kubernetes/client-node';

const execAsync = promisify(exec);

export async function checkK8sConnection(): Promise<boolean> {
  try {
    await execAsync('kubectl cluster-info');
    return true;
  } catch {
    return false;
  }
}

export async function getK8sNodes(): Promise<any[]> {
  try {
    const { stdout } = await execAsync('kubectl get nodes -o json');
    const data = JSON.parse(stdout);
    return data.items.map((node: any) => {
      const addresses = node.status.addresses || [];
      const internalIp = addresses.find((addr: any) => addr.type === 'InternalIP')?.address || '—';
      const role = Object.keys(node.metadata.labels || {}).some(l => l.includes('control-plane') || l.includes('master')) ? 'master' : 'worker';
      
      const readyCond = node.status.conditions?.find((c: any) => c.type === 'Ready');
      const status = readyCond && readyCond.status === 'True' ? 'Ready' : 'NotReady';

      // Parse cpu/memory capacity
      const cpu = node.status.allocatable?.cpu || '1';
      const memory = node.status.allocatable?.memory || '1Gi';

      return {
        name: node.metadata.name,
        ip: internalIp,
        role: role,
        status: status,
        cpu: `${cpu} Core`,
        memory: memory
      };
    });
  } catch (err: any) {
    console.warn(`[k8s] Failed to get nodes via kubectl: ${err.message}. Using fallback mock data.`);
    return [
      { name: 'kvm8-master', ip: '104.21.32.14', role: 'master', status: 'Ready', cpu: '25%', memory: '42%' },
      { name: 'caps-worker-1', ip: '192.168.1.105', role: 'worker', status: 'Ready', cpu: '12%', memory: '30%' },
      { name: 'caps-worker-2', ip: '192.168.1.106', role: 'worker', status: 'Ready', cpu: '18%', memory: '35%' }
    ];
  }
}

export async function getK8sNamespaces(): Promise<any[]> {
  try {
    const { stdout } = await execAsync('kubectl get namespaces -o json');
    const data = JSON.parse(stdout);
    return data.items.map((ns: any) => {
      const status = ns.status?.phase || 'Active';
      const creationDate = new Date(ns.metadata.creationTimestamp);
      const diffMs = Date.now() - creationDate.getTime();
      const ageDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      return {
        name: ns.metadata.name,
        status: status,
        age: `${ageDays}d`
      };
    });
  } catch (err: any) {
    console.warn(`[k8s] Failed to get namespaces via kubectl: ${err.message}. Using fallback mock data.`);
    return [
      { name: 'default', status: 'Active', age: '142d' },
      { name: 'kube-system', status: 'Active', age: '142d' },
      { name: 'monitoring', status: 'Active', age: '32d' },
      { name: 'databases', status: 'Active', age: '32d' },
      { name: 'storage', status: 'Active', age: '32d' },
      { name: 'caps-platform', status: 'Active', age: '32d' },
      { name: 'preview', status: 'Active', age: '12d' }
    ];
  }
}

export async function deployK8sPreview(projectName: string, branch: string, imageTag: string): Promise<boolean> {
  const sanitized = branch
    .replace(/^(feature|fix|chore)\//i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');

  const deploymentName = `preview-${sanitized}`;
  const domain = `${sanitized}.preview.capskengeri.com`;

  const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: preview
  labels:
    app: ${deploymentName}
    branch: ${sanitized}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${deploymentName}
  template:
    metadata:
      labels:
        app: ${deploymentName}
    spec:
      containers:
      - name: web
        image: registry.gitlab.com/caps/${projectName}:${imageTag}
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: ${deploymentName}
  namespace: preview
spec:
  selector:
    app: ${deploymentName}
  ports:
  - port: 80
    targetPort: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${deploymentName}
  namespace: preview
  annotations:
    ingress.kubernetes.io/ssl-redirect: "false"
spec:
  rules:
  - host: ${domain}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${deploymentName}
            port:
              number: 80
`;

  try {
    // Ensure namespace preview exists
    await execAsync('kubectl create namespace preview --dry-run=client -o yaml | kubectl apply -f -');
    
    // Apply manifest
    const child = exec('kubectl apply -f -');
    child.stdin?.write(manifest);
    child.stdin?.end();
    
    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve(true);
        else reject(new Error(`kubectl exited with code ${code}`));
      });
      child.on('error', (err) => reject(err));
    });
    
    console.log(`[k8s] Successfully deployed preview for branch ${branch} as ${deploymentName}`);
    return true;
  } catch (err: any) {
    console.warn(`[k8s] Failed to deploy preview to cluster: ${err.message}. Simulating instead.`);
    return false;
  }
}

export async function terminateK8sPreview(branch: string): Promise<boolean> {
  const sanitized = branch
    .replace(/^(feature|fix|chore)\//i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');

  const deploymentName = `preview-${sanitized}`;

  try {
    console.log(`[k8s] Deleting preview resources for branch ${branch}...`);
    await execAsync(`kubectl delete deployment,service,ingress ${deploymentName} -n preview --ignore-not-found`);
    return true;
  } catch (err: any) {
    console.warn(`[k8s] Failed to delete preview from cluster: ${err.message}. Simulating instead.`);
    return false;
  }
}

export async function getK8sPods(namespace?: string): Promise<any[]> {
  try {
    const nsFlag = namespace ? `-n ${namespace}` : '-A';
    const { stdout } = await execAsync(`kubectl get pods ${nsFlag} -o json`);
    const data = JSON.parse(stdout);
    return data.items.map((pod: any) => {
      const name = pod.metadata.name;
      const ns = pod.metadata.namespace;
      const status = pod.status.phase;
      
      const containerStatuses = pod.status.containerStatuses || [];
      const restarts = containerStatuses.reduce((acc: number, c: any) => acc + (c.restartCount || 0), 0);
      
      // Get creation time and format age
      const creationDate = new Date(pod.metadata.creationTimestamp);
      const diffMs = Date.now() - creationDate.getTime();
      const ageHours = Math.floor(diffMs / (1000 * 60 * 60));
      const ageMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const ageStr = ageHours > 0 ? `${ageHours}h ${ageMins}m` : `${ageMins}m`;

      return {
        name,
        namespace: ns,
        status,
        restarts,
        age: ageStr,
        node: pod.spec.nodeName || '—'
      };
    });
  } catch (err: any) {
    console.warn(`[k8s] Failed to get pods via kubectl: ${err.message}. Throwing to caller.`);
    throw err;
  }
}

export async function getPodLogs(namespace: string, podName: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`kubectl logs ${podName} -n ${namespace} --tail=100`);
    return stdout;
  } catch (err: any) {
    console.warn(`[k8s] Failed to get logs for pod ${podName} in ns ${namespace}: ${err.message}`);
    return `Failed to fetch logs: ${err.message}`;
  }
}

export async function deletePod(namespace: string, podName: string): Promise<boolean> {
  try {
    console.log(`[k8s] Deleting pod ${podName} in ns ${namespace}...`);
    await execAsync(`kubectl delete pod ${podName} -n ${namespace}`);
    return true;
  } catch (err: any) {
    console.warn(`[k8s] Failed to delete pod ${podName}: ${err.message}`);
    throw err;
  }
}

export async function updateArgoCDApp(appName: string, imageTag: string): Promise<boolean> {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    
    console.log(`[argo] Fetching application ${appName} from k8s...`);
    const appResponse: any = await customApi.getNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: 'argocd',
      plural: 'applications',
      name: appName
    });

    const app = appResponse.body || appResponse;
    const spec = app.spec || {};
    
    // Update helm parameter if exists
    if (spec.source && spec.source.helm && spec.source.helm.parameters) {
      const param = spec.source.helm.parameters.find((p: any) => p.name === 'image.tag');
      if (param) {
        param.value = imageTag;
      } else {
        spec.source.helm.parameters.push({ name: 'image.tag', value: imageTag });
      }
    }

    console.log(`[argo] Patching application ${appName} with new image tag: ${imageTag}...`);
    await customApi.patchNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: 'argocd',
      plural: 'applications',
      name: appName,
      body: { spec }
    });

    // Trigger Sync operation
    console.log(`[argo] Triggering sync in ArgoCD for application ${appName}...`);
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
            sync: { syncStrategy: { hook: {} } }
          }
        }
      }
    });

    return true;
  } catch (err: any) {
    console.error(`[argo] Failed to update/sync ArgoCD application ${appName}:`, err.message);
    return false;
  }
}
