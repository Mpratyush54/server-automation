import React from 'react';
import { PlatformProvider, usePlatform, PlatformConfig } from '@mpratyush54/sdk-react';

const config: PlatformConfig = {
  apiBase: import.meta.env.VITE_PLATFORM_URL,
  token: import.meta.env.VITE_PLATFORM_SDK_TOKEN,
  projectId: import.meta.env.VITE_PLATFORM_PROJECT_ID,
  environment: 'development',
  appName: 'sdk-react-example',
};

function Home() {
  const { api, config: cfg } = usePlatform();
  const [status, setStatus] = React.useState<string>('idle');

  async function ping() {
    setStatus('loading…');
    try {
      const { data } = await api.get('/api/health');
      setStatus(JSON.stringify(data));
    } catch (e: any) {
      setStatus(e?.message || 'error');
    }
  }

  return (
    <div>
      <h1>Platform React example</h1>
      <p>Project: {cfg.projectId}</p>
      <button type="button" onClick={ping}>
        Ping /api/health
      </button>
      <pre>{status}</pre>
    </div>
  );
}

/** Drop this as your root component (Vite / CRA). */
export default function BasicApp() {
  return (
    <PlatformProvider config={config}>
      <Home />
    </PlatformProvider>
  );
}
