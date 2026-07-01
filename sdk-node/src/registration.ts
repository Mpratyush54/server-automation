import { AxiosInstance } from 'axios';

export class RegistrationClient {
  constructor(private http: AxiosInstance) {}

  async register(payload: {
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
  }): Promise<any> {
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
