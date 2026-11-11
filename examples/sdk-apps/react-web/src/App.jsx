import React, { useState } from 'react';
import { Link, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { setConsent, useRumPageView } from '@mpratyush54/sdk-react';

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

function ConsentBanner() {
  const [choice, setChoice] = useState(() => {
    try { return localStorage.getItem('platform.consent.replay'); } catch { return null; }
  });
  if (choice) return <p style={{ color: '#555', fontSize: 13 }}>Session replay: {choice === '1' ? 'allowed' : 'declined'}.</p>;
  const decide = (allow) => { setConsent({ replay: allow }); setChoice(allow ? '1' : '0'); };
  return (
    <div data-testid="consent-banner" style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 16 }}>
      This demo can record a privacy-preserving session replay (all inputs masked).{' '}
      <button data-testid="replay-allow" onClick={() => decide(true)}>Allow session replay</button>{' '}
      <button data-testid="replay-decline" onClick={() => decide(false)}>Decline</button>
    </div>
  );
}

/** Form with personal data: replay must show every value masked. */
function Checkout() {
  const [sent, setSent] = useState(false);
  return (
    <form onSubmit={(e) => { e.preventDefault(); setSent(true); }} style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
      <label>Full name <input name="name" data-testid="name" autoComplete="off" /></label>
      <label>E-mail <input name="email" type="email" data-testid="email" autoComplete="off" /></label>
      <label>Password <input name="password" type="password" data-testid="password" autoComplete="off" /></label>
      <label>Card number <input name="card" data-testid="card" autoComplete="off" inputMode="numeric" /></label>
      <label>Notes <textarea name="notes" data-testid="notes" /></label>
      <p className="platform-mask" data-testid="masked-text">Account balance: 1234.56</p>
      <button type="submit" data-testid="submit">Place order</button>
      {sent && <p data-testid="sent">Order placed.</p>}
    </form>
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

export default function App() {
  // One RUM view per route (react-router v6/v7): /orders/101 is recorded as /orders/:id.
  useRumPageView(useLocation());
  return (
    <div style={{ fontFamily: 'system-ui,Segoe UI,sans-serif', maxWidth: 720, margin: '40px auto', padding: 16 }}>
      <h1>React client → Node API (Platform SDK)</h1>
      <nav style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <Link to="/">Home</Link>
        <Link to="/orders">Orders</Link>
        <Link to="/checkout">Checkout</Link>
      </nav>
      <ConsentBanner />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/checkout" element={<Checkout />} />
      </Routes>
    </div>
  );
}
