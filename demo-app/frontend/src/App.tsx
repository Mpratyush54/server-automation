import { useState } from 'react';
import { CapsProvider, useCaps, BugReporterWidget } from '@mpratyush54/sdk-react';

const capsConfig = {
  apiBase: 'https://148.113.58.205.sslip.io',
  token: 'caps_sdk_live_1ec8b9aa2d594c2b974f4d346734a6f2',
  projectId: 'bc145854-46fe-4480-a751-395a0b593004',
  environment: 'development'
};

function Dashboard() {
  const { api } = useCaps();
  const [backendData, setBackendData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [logMessage, setLogMessage] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  const fetchBackendData = async () => {
    setLoading(true);
    setStatusMsg('');
    try {
      // This goes through the CapsProvider axios instance, so it triggers API metrics tracking automatically!
      const res = await api.get('/api/data');
      setBackendData(res.data);
      setStatusMsg('Metrics tracked successfully!');
    } catch (err: any) {
      console.error("Fetch error:", err);
      setStatusMsg('Fetch failed. Is backend running?');
    } finally {
      setLoading(false);
    }
  };

  const sendTestLog = async (level: 'info' | 'error') => {
    if (!logMessage.trim()) return;
    try {
      await api.post('/api/log-test', { level, message: logMessage });
      setStatusMsg(`${level.toUpperCase()} log ingested successfully!`);
      setLogMessage('');
    } catch (err) {
      console.error("Log error:", err);
      setStatusMsg('Failed to send log.');
    }
  };

  const triggerConsoleLog = (level: 'log' | 'warn' | 'error') => {
    if (level === 'log') console.log("User clicked test console log button at " + new Date().toLocaleTimeString());
    if (level === 'warn') console.warn("User triggered a warning!");
    if (level === 'error') console.error("User triggered a mock console error!");
    setStatusMsg(`Console ${level} triggered! Open the bug reporter widget to see it attached.`);
  };

  return (
    <div style={{
      minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a, #1e1b4b)',
      color: '#f8fafc', fontFamily: 'system-ui, sans-serif', padding: '40px 20px',
      display: 'flex', flexDirection: 'column', alignItems: 'center'
    }}>
      <div style={{ maxWidth: '800px', width: '100%' }}>
        <header style={{ textAlign: 'center', marginBottom: '40px' }}>
          <h1 style={{
            fontSize: '3rem', margin: '0 0 10px', fontWeight: 800,
            background: 'linear-gradient(to right, #a855f7, #3b82f6)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'
          }}>
            CAPS SDK Demo
          </h1>
          <p style={{ color: '#94a3b8', fontSize: '1.1rem' }}>
            Testing Node.js and React SDK integrations on the live platform
          </p>
        </header>

        {statusMsg && (
          <div style={{
            padding: '12px 16px', background: '#3b82f620', border: '1px solid #3b82f640',
            borderRadius: '8px', color: '#60a5fa', marginBottom: '24px', fontSize: '0.95rem',
            textAlign: 'center', transition: 'all 0.3s ease'
          }}>
            ℹ️ {statusMsg}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '32px' }}>
          {/* Card 1: API Metrics */}
          <div style={{
            background: '#1e293b70', border: '1px solid #334155', borderRadius: '12px',
            padding: '24px', backdropFilter: 'blur(8px)'
          }}>
            <h2 style={{ fontSize: '1.3rem', margin: '0 0 12px', color: '#a855f7' }}>📊 API Metrics Ingest</h2>
            <p style={{ color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: '20px' }}>
              Queries the Node.js backend. The React SDK interceptor measures duration and reports it to the platform.
            </p>
            <button
              onClick={fetchBackendData}
              disabled={loading}
              style={{
                width: '100%', padding: '10px', borderRadius: '6px', border: 'none',
                background: '#a855f7', color: '#fff', fontWeight: 600, cursor: 'pointer',
                fontSize: '0.95rem', opacity: loading ? 0.7 : 1
              }}
            >
              {loading ? 'Fetching...' : 'Query Backend (api.get)'}
            </button>

            {backendData && (
              <pre style={{
                marginTop: '16px', background: '#0f172a', padding: '12px', borderRadius: '6px',
                fontSize: '0.8rem', overflowX: 'auto', border: '1px solid #1e293b', color: '#10b981'
              }}>
                {JSON.stringify(backendData, null, 2)}
              </pre>
            )}
          </div>

          {/* Card 2: Logging Ingest */}
          <div style={{
            background: '#1e293b70', border: '1px solid #334155', borderRadius: '12px',
            padding: '24px', backdropFilter: 'blur(8px)'
          }}>
            <h2 style={{ fontSize: '1.3rem', margin: '0 0 12px', color: '#3b82f6' }}>📝 Server Logs Ingest</h2>
            <p style={{ color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: '20px' }}>
              Triggers the Node SDK `caps.logger` to record standard server-side logs and syncs them to Loki.
            </p>
            <input
              type="text"
              placeholder="Type log message..."
              value={logMessage}
              onChange={(e) => setLogMessage(e.target.value)}
              style={{
                width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #475569',
                background: '#0f172a', color: '#fff', fontSize: '0.9rem', marginBottom: '12px',
                boxSizing: 'border-box'
              }}
            />
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => sendTestLog('info')}
                disabled={!logMessage.trim()}
                style={{
                  flex: 1, padding: '8px', borderRadius: '6px', border: 'none',
                  background: '#3b82f6', color: '#fff', fontWeight: 600, cursor: 'pointer',
                  opacity: logMessage.trim() ? 1 : 0.6
                }}
              >
                Send Info
              </button>
              <button
                onClick={() => sendTestLog('error')}
                disabled={!logMessage.trim()}
                style={{
                  flex: 1, padding: '8px', borderRadius: '6px', border: 'none',
                  background: '#ef4444', color: '#fff', fontWeight: 600, cursor: 'pointer',
                  opacity: logMessage.trim() ? 1 : 0.6
                }}
              >
                Send Error
              </button>
            </div>
          </div>
        </div>

        {/* Card 3: Console capture and Bug report */}
        <div style={{
          background: '#1e293b70', border: '1px solid #334155', borderRadius: '12px',
          padding: '24px', marginBottom: '32px', backdropFilter: 'blur(8px)'
        }}>
          <h2 style={{ fontSize: '1.3rem', margin: '0 0 12px', color: '#10b981' }}>🐛 Console & Bug Reporting</h2>
          <p style={{ color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: '20px' }}>
            Trigger local browser console entries, then click the floating red bug icon in the bottom right corner to submit a screenshot + logs!
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => triggerConsoleLog('log')}
              style={{
                flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid #475569',
                background: 'transparent', color: '#f8fafc', cursor: 'pointer', fontWeight: 500
              }}
            >
              console.log()
            </button>
            <button
              onClick={() => triggerConsoleLog('warn')}
              style={{
                flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid #fbbf24',
                background: 'transparent', color: '#fbbf24', cursor: 'pointer', fontWeight: 500
              }}
            >
              console.warn()
            </button>
            <button
              onClick={() => triggerConsoleLog('error')}
              style={{
                flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid #f87171',
                background: 'transparent', color: '#f87171', cursor: 'pointer', fontWeight: 500
              }}
            >
              console.error()
            </button>
          </div>
        </div>

        <footer style={{ textAlign: 'center', color: '#64748b', fontSize: '0.85rem', marginTop: '40px' }}>
          CAPS Platform Developer Suite — Live SDK Test
        </footer>
      </div>

      <BugReporterWidget config={capsConfig} />
    </div>
  );
}

export default function App() {
  return (
    <CapsProvider config={capsConfig}>
      <Dashboard />
    </CapsProvider>
  );
}
