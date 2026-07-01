import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { PlatformConfig } from './context';

interface ConsoleEntry {
  level: string;
  message: string;
  timestamp: string;
}

interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  duration: number;
  timestamp: string;
}

export interface BugReporterWidgetProps {
  config: PlatformConfig;
}

export function BugReporterWidget({ config }: BugReporterWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const consoleLogs = useRef<ConsoleEntry[]>([]);
  const networkLogs = useRef<NetworkEntry[]>([]);

  useEffect(() => {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    const capture = (level: string, ...args: any[]) => {
      consoleLogs.current.push({
        level,
        message: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
        timestamp: new Date().toISOString(),
      });
      if (consoleLogs.current.length > 100) consoleLogs.current.shift();
    };

    console.log = (...args) => { capture('log', ...args); origLog.apply(console, args); };
    console.warn = (...args) => { capture('warn', ...args); origWarn.apply(console, args); };
    console.error = (...args) => { capture('error', ...args); origError.apply(console, args); };

    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const start = Date.now();
      try {
        const res = await origFetch.apply(window, args);
        networkLogs.current.push({
          method: (args[1]?.method as string) || 'GET',
          url: typeof args[0] === 'string' ? args[0] : (args[0] as Request).url,
          status: res.status,
          duration: Date.now() - start,
          timestamp: new Date().toISOString(),
        });
        if (networkLogs.current.length > 100) networkLogs.current.shift();
        return res;
      } catch (err) {
        networkLogs.current.push({
          method: (args[1]?.method as string) || 'GET',
          url: typeof args[0] === 'string' ? args[0] : (args[0] as Request).url,
          status: 0,
          duration: Date.now() - start,
          timestamp: new Date().toISOString(),
        });
        throw err;
      }
    };

    return () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      window.fetch = origFetch;
    };
  }, []);

  const captureScreenshot = useCallback(async (): Promise<string | null> => {
    try {
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(document.body);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }, []);

  const handleSubmit = async () => {
    if (!description.trim()) return;
    setSending(true);

    try {
      const screenshot = await captureScreenshot();

      await axios.post(`${config.apiBase}/api/sdk/bug-report`, {
        projectId: config.projectId,
        environment: config.environment || 'production',
        description,
        category: 'user-report',
        consoleLogs: [...consoleLogs.current],
        networkTimeline: [...networkLogs.current],
        screenshotBase64: screenshot,
        browserInfo: {
          userAgent: navigator.userAgent,
          url: window.location.href,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        },
        appState: {},
      }, {
        headers: { Authorization: `Bearer ${config.token}` },
      });

      setSent(true);
      setTimeout(() => { setIsOpen(false); setSent(false); setDescription(''); }, 2000);
    } catch {
      alert('Failed to submit bug report.');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          position: 'fixed', bottom: '20px', right: '20px', zIndex: 99999,
          width: '48px', height: '48px', borderRadius: '50%',
          background: '#dc2626', color: '#fff', border: 'none', cursor: 'pointer',
          fontSize: '20px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        title="Report a bug"
      >
        🐛
      </button>

      {isOpen && (
        <div style={{
          position: 'fixed', bottom: '80px', right: '20px', zIndex: 99999,
          width: '380px', maxHeight: '500px', background: '#1a1a2e', color: '#e0e0e0',
          borderRadius: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          fontFamily: 'system-ui, sans-serif', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ padding: '16px', borderBottom: '1px solid #333', fontWeight: 600, fontSize: '14px' }}>
            Report a Bug
          </div>
          {sent ? (
            <div style={{ padding: '40px 16px', textAlign: 'center', color: '#22c55e' }}>
              Bug report submitted. Thank you!
            </div>
          ) : (
            <>
              <div style={{ padding: '16px', flex: 1, overflow: 'auto' }}>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the bug you encountered..."
                  style={{
                    width: '100%', minHeight: '120px', padding: '10px', borderRadius: '8px',
                    border: '1px solid #444', background: '#0f0f23', color: '#e0e0e0',
                    resize: 'vertical', fontFamily: 'inherit', fontSize: '13px',
                  }}
                />
                <div style={{ marginTop: '8px', fontSize: '11px', color: '#888' }}>
                  A screenshot, console logs, and network history will be attached automatically.
                </div>
              </div>
              <div style={{ padding: '12px 16px', borderTop: '1px solid #333', display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setIsOpen(false)}
                  style={{
                    flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid #444',
                    background: 'transparent', color: '#ccc', cursor: 'pointer', fontSize: '13px',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={sending || !description.trim()}
                  style={{
                    flex: 1, padding: '8px', borderRadius: '6px', border: 'none',
                    background: '#dc2626', color: '#fff', cursor: sending ? 'wait' : 'pointer',
                    fontSize: '13px', opacity: sending || !description.trim() ? 0.6 : 1,
                  }}
                >
                  {sending ? 'Submitting...' : 'Submit Report'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
