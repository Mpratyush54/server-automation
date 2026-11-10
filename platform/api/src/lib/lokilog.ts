import axios from 'axios';
import { scrubValue, type ScrubOptions } from './pii-scrub';

export async function forwardToLoki(logs: any[], scrubOpts?: ScrubOptions): Promise<void> {
  const lokiUrl = process.env.LOKI_URL || 'http://localhost:3100';
  try {
    const streams = logs.map((log) => {
      const scrubbed = scrubOpts ? scrubValue(log, { ...scrubOpts, target: 'logs' }) : log;
      const telemetryType = scrubbed.level === 'ERROR' ? 'errors' : 'logs';
      return {
        stream: {
          project_id: scrubbed.projectId,
          environment_id: scrubbed.environmentId || scrubbed.environment,
          service_name: scrubbed.serviceName,
          level: scrubbed.level,
          telemetry_type: telemetryType,
        },
        values: [[String(Date.now() * 1e6), JSON.stringify(scrubbed)]],
      };
    });
    await axios.post(`${lokiUrl}/loki/api/v1/push`, { streams }, { timeout: 3000 });
  } catch { /* best-effort forward */ }
}
