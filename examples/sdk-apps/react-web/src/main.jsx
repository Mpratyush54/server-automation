import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { PlatformProvider } from '@mpratyush54/sdk-react';
import App from './App.jsx';

const API = import.meta.env.VITE_API_URL || '';

// Frontend RUM is one option on the provider. The telemetry block (Faro endpoint + public
// browser token from GET /api/sdk/config) is served by nginx as /rum-config.json, written
// at container start from RUM_* env vars; when it is absent or disabled, Faro is never loaded.
const platformConfig = {
  apiBase: import.meta.env.VITE_PLATFORM_URL || '',
  token: '', // the SDK token stays on the backend; RUM does not need it
  projectId: import.meta.env.VITE_PROJECT_ID || 'sdk-demo-apps',
  environment: 'development',
  appName: 'sdk-react-web',
  rum: {
    telemetryUrl: '/rum-config.json',
    // Click + scroll-depth heatmaps (rum-config.json heatmapsEndpoint/heatmapsToken); lazy-loaded.
    heatmaps: true,
    // traceparent goes to this app and the demo Node API only (never to third parties).
    propagateTo: [window.location.origin, ...(API ? [new URL(API, window.location.href).origin] : [])],
    // Session replay (#40): every session is sampled in this demo; nothing is recorded until the
    // visitor clicks "Allow session replay" (setConsent). Inputs are always masked. Needs
    // `replayEndpoint` in /rum-config.json (RUM_REPLAY_ENDPOINT), else replay stays off.
    replay: { sampleRate: 1, onErrorSampleRate: 1 },
  },
};

createRoot(document.getElementById('root')).render(
  <PlatformProvider config={platformConfig}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </PlatformProvider>,
);
