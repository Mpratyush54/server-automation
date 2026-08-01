import { AxiosInstance } from 'axios';

export interface RegisterPayload {
  projectName: string;
  environmentName: string;
  serviceName: string;
  version: string;
  branch?: string;
  commitSha?: string;
  namespace?: string;
  hostname?: string;
  metadata?: Record<string, any>;
  dbTypes?: string[];
  infisicalEnv?: string;
  /** Wires ArgoCD Application to this Git repo on register */
  repositoryUrl?: string;
  /** Manifests path in repo (e.g. examples/sdk-demo/k8s) */
  gitPath?: string;
  gitRevision?: string;
  domain?: string;
  /** Prefer GitOps over creating a local :latest Deployment */
  gitops?: boolean;
}

export class RegistrationClient {
  constructor(private http: AxiosInstance) {}

  async register(payload: RegisterPayload): Promise<any> {
    try {
      const { data } = await this.http.post('/api/sdk/register', payload);
      return data;
    } catch (err: any) {
      console.error('[platform] Register error (silent):', err.message);
      return null;
    }
  }

  async deregister(projectId: string, serviceName: string): Promise<void> {
    try {
      await this.http.post('/api/sdk/deregister', { projectId, serviceName });
    } catch {}
  }

  async getDbCredentials(projectId: string, dbTypes: string[]): Promise<Record<string, any>> {
    try {
      const { data } = await this.http.get('/api/sdk/db-credentials', {
        params: { projectId, dbTypes: dbTypes.join(',') },
      });
      return data;
    } catch {
      return {};
    }
  }
}
