import { AxiosInstance } from 'axios';
import { PlatformOptions } from './client';

export class HeartbeatClient {
  private dbHealth: Array<{ dbType: string; status: string; metrics?: any }> = [];

  constructor(
    private http: AxiosInstance,
    private options: PlatformOptions,
  ) {}

  setDbHealth(health: Array<{ dbType: string; status: string; metrics?: any }>): void {
    this.dbHealth = health;
  }

  async send(): Promise<void> {
    try {
      await this.http.post('/api/sdk/heartbeat', {
        projectId: this.options.projectName,
        serviceName: this.options.projectName,
        dbHealth: this.dbHealth,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[platform] Heartbeat error (silent):', err.message);
    }
  }
}
