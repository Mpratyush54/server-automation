import { AxiosInstance } from 'axios';

export class ConfigClient {
  private cache: Map<string, any> = new Map();
  private http?: AxiosInstance;
  private projectName?: string;
  private environmentName?: string;
  private refreshInterval?: ReturnType<typeof setInterval>;

  constructor(private httpInstance: AxiosInstance) {
    this.http = httpInstance;
  }

  configure(projectName: string, environmentName: string) {
    this.projectName = projectName;
    this.environmentName = environmentName;
  }

  async loadAll(): Promise<void> {
    if (!this.http || !this.projectName) return;
    try {
      const { data } = await this.http.get('/api/sdk/config', {
        params: { projectId: this.projectName, environmentId: this.environmentName },
      });
      
      this.cache.clear();
      for (const [key, value] of Object.entries(data)) {
        this.cache.set(key, value);
      }
    } catch (err: any) {
      console.error('[platform] Failed to fetch config values (silent):', err.message);
    }
  }

  startBackgroundRefresh(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = setInterval(() => this.loadAll(), 30000);
  }

  stopBackgroundRefresh(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }

  get(key: string, defaultValue?: any): any {
    if (this.cache.has(key)) {
      const val = this.cache.get(key);
      if (val === 'true') return true;
      if (val === 'false') return false;
      return val;
    }
    return defaultValue !== undefined ? defaultValue : null;
  }
}
export default ConfigClient;
