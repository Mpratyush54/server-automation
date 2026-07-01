import axios from 'axios';

export async function forwardToLoki(logs: any[]): Promise<void> {
  const lokiUrl = process.env.LOKI_URL || 'http://localhost:3100';
  try {
    const streams = logs.map(log => ({
      stream: {
        project_id: log.projectId,
        environment_id: log.environmentId,
        service_name: log.serviceName,
        level: log.level,
      },
      values: [[String(Date.now() * 1e6), JSON.stringify(log)]],
    }));
    await axios.post(`${lokiUrl}/loki/api/v1/push`, { streams }, { timeout: 3000 });
  } catch {}
}
