import React, { useState } from 'react';

const API = import.meta.env.VITE_API_URL || '';

export default function App() {
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  async function hit(path, opts) {
    setBusy(true);
    try {
      const res = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}client=react`, opts);
      const data = await res.json();
      setLog((prev) => [`[react] ${opts?.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data).slice(0, 120)}`, ...prev].slice(0, 12));
    } catch (e) {
      setLog((prev) => [`[react] ERROR ${path}: ${e.message}`, ...prev].slice(0, 12));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui,Segoe UI,sans-serif', maxWidth: 720, margin: '40px auto', padding: 16 }}>
      <h1>React client → Node API (Platform SDK)</h1>
      <p style={{ color: '#555' }}>
        Clicks generate traffic on the Node service. The SDK middleware records per-route latency and heartbeats for Telemetry.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <button disabled={busy} onClick={() => hit('/api/hello')}>GET /api/hello</button>
        <button disabled={busy} onClick={() => hit('/api/users')}>GET /api/users</button>
        <button disabled={busy} onClick={() => hit('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: 'widget', qty: 2 }) })}>
          POST /api/orders
        </button>
        <button disabled={busy} onClick={() => hit('/api/slow')}>GET /api/slow</button>
        <button disabled={busy} onClick={() => hit('/api/db-check')}>GET /api/db-check</button>
      </div>
      <pre style={{ background: '#0b0f19', color: '#34d399', padding: 16, borderRadius: 8, minHeight: 180 }}>{log.join('\n') || 'No requests yet.'}</pre>
    </div>
  );
}
