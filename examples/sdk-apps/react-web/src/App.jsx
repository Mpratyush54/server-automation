import React, { useState } from 'react';
import { Link, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useRumPageView } from '@mpratyush54/sdk-react';

const API = import.meta.env.VITE_API_URL || '';

function useApiLog() {
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
  return { log, busy, hit };
}

function Home() {
  const { log, busy, hit } = useApiLog();
  return (
    <>
      <p style={{ color: '#555' }}>
        Clicks generate traffic on the Node service. The backend SDK records per-route latency; with RUM enabled the
        browser also reports web vitals, errors, resource timings, clicks and a client span per API call (linked to the
        backend trace through the <code>traceparent</code> header).
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <button disabled={busy} onClick={() => hit('/api/hello')}>GET /api/hello</button>
        <button disabled={busy} onClick={() => hit('/api/users')}>GET /api/users</button>
        <button disabled={busy} onClick={() => hit('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: 'widget', qty: 2 }) })}>
          POST /api/orders
        </button>
        <button disabled={busy} onClick={() => hit('/api/slow')}>GET /api/slow</button>
        <button disabled={busy} onClick={() => hit('/api/db-check')}>GET /api/db-check</button>
        <button data-rum-name="throw-error" onClick={() => setTimeout(() => { throw new Error('demo error from react-web'); })}>
          Throw JS error
        </button>
      </div>
      <pre style={{ background: '#0b0f19', color: '#34d399', padding: 16, borderRadius: 8, minHeight: 180 }}>{log.join('\n') || 'No requests yet.'}</pre>
    </>
  );
}

function Orders() {
  return (
    <ul>
      {[101, 102, 103].map((id) => (
        <li key={id}><Link to={`/orders/${id}`}>Order {id}</Link></li>
      ))}
    </ul>
  );
}

function OrderDetail() {
  const { id } = useParams();
  const { log, busy, hit } = useApiLog();
  return (
    <>
      <h2>Order {id}</h2>
      <button disabled={busy} onClick={() => hit(`/api/users?order=${id}`)}>Load customer</button>
      <pre style={{ background: '#0b0f19', color: '#34d399', padding: 16, borderRadius: 8 }}>{log.join('\n') || '—'}</pre>
    </>
  );
}

const SECTIONS = ['deploys', 'databases', 'observability', 'security', 'pricing'];

// Heatmap demo page: a long landing-style page with buttons in fixed places, so clicks
// (x/y normalised to the document) and scroll depth produce a recognisable heatmap.
function Features() {
  const [clicked, setClicked] = useState('');
  return (
    <>
      <section style={{ padding: '48px 16px', textAlign: 'center', background: '#eef2ff', borderRadius: 8 }}>
        <h2>Ship faster with the Platform SDK</h2>
        <p>Clicks and scroll depth on this page feed the project's Heatmaps view.</p>
        <button id="cta-primary" data-rum-name="cta-primary" style={{ margin: 8, padding: '12px 20px' }} onClick={() => setClicked('primary')}>Start free trial</button>
        <button id="cta-secondary" style={{ margin: 8, padding: '12px 20px' }} onClick={() => setClicked('secondary')}>Book a demo</button>
      </section>
      {SECTIONS.map((id) => (
        <section key={id} id={'section-' + id} style={{ minHeight: 360, padding: '24px 16px', borderBottom: '1px solid #e5e7eb' }}>
          <h3>{id[0].toUpperCase() + id.slice(1)}</h3>
          <p>Placeholder copy for the heatmap demo. Scroll down to increase the recorded scroll depth.</p>
          <button className="learn" data-rum-name={'learn-' + id} onClick={() => setClicked(id)}>Learn more</button>
        </section>
      ))}
      <footer style={{ padding: '48px 16px', textAlign: 'center' }}>
        <button id="cta-footer" data-rum-name="cta-footer" onClick={() => setClicked('footer')}>Get started</button>
        <p>Last clicked: {clicked || '—'}</p>
      </footer>
    </>
  );
}

export default function App() {
  // One RUM view per route (react-router v6/v7): /orders/101 is recorded as /orders/:id.
  useRumPageView(useLocation());
  return (
    <div style={{ fontFamily: 'system-ui,Segoe UI,sans-serif', maxWidth: 720, margin: '40px auto', padding: 16 }}>
      <h1>React client → Node API (Platform SDK)</h1>
      <nav style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <Link to="/">Home</Link>
        <Link to="/orders">Orders</Link>
        <Link to="/features">Features</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/features" element={<Features />} />
      </Routes>
    </div>
  );
}
