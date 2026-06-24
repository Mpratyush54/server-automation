export interface NodeInfo {
  name: string;
  status: string;
  roles: string[];
  age: string;
  version: string;
  os: string;
  ip: string;
  cpu: string;
  memory: string;
  labels: Record<string, string>;
}

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  restarts: number;
  age: string;
  node: string;
  ip: string;
  labels: Record<string, string>;
}

export interface DeploymentInfo {
  name: string;
  namespace: string;
  ready: string;
  upToDate: number;
  available: number;
  age: string;
  strategy: string;
}

export interface ServiceInfo {
  name: string;
  namespace: string;
  type: string;
  clusterIP: string;
  externalIP: string;
  ports: string;
  age: string;
}

export interface NamespaceInfo {
  name: string;
  status: string;
  age: string;
  labels: Record<string, string>;
}

export interface ClusterHealth {
  connected: boolean;
  nodesReady: number;
  nodesTotal: number;
  podsRunning: number;
  podsFailed: number;
  cpuUsage: number;
  memoryUsage: number;
  storageUsage: number;
  kubeconfigPath: string;
  error?: string;
}

export async function initKubernetes(): Promise<boolean> {
  return false;
}

export function isKubernetesConnected(): boolean {
  return false;
}

export async function getClusterHealth(): Promise<ClusterHealth> {
  return {
    connected: false,
    nodesReady: 0,
    nodesTotal: 0,
    podsRunning: 0,
    podsFailed: 0,
    cpuUsage: 0,
    memoryUsage: 0,
    storageUsage: 0,
    kubeconfigPath: '',
    error: 'Kubernetes configuration disabled in this module'
  };
}

export async function listNodes(): Promise<NodeInfo[]> {
  return [];
}

export async function listPods(namespace?: string): Promise<PodInfo[]> {
  return [];
}

export async function listDeployments(namespace?: string): Promise<DeploymentInfo[]> {
  return [];
}

export async function listServices(namespace?: string): Promise<ServiceInfo[]> {
  return [];
}

export async function listNamespaces(): Promise<NamespaceInfo[]> {
  return [];
}

export async function createNamespace(name: string, labels?: Record<string, string>): Promise<void> {
  return;
}

export async function deleteNamespace(name: string): Promise<void> {
  return;
}

export async function getPodLogs(namespace: string, podName: string, container?: string, tailLines: number = 100): Promise<string> {
  return '';
}

export async function scaleDeployment(namespace: string, name: string, replicas: number): Promise<void> {
  return;
}

export async function deletePod(namespace: string, name: string): Promise<void> {
  return;
}

export async function getEvents(namespace?: string): Promise<any[]> {
  return [];
}
