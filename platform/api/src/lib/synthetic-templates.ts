/** Starter templates for the portal check editor (#42). Plain data; validated like any input on save. */
export const SYNTHETIC_TEMPLATES = [
  {
    id: 'http-uptime',
    name: 'HTTP uptime',
    description: 'GET a page, expect 2xx in under 2 seconds.',
    check: {
      type: 'http',
      intervalSeconds: 300,
      timeoutMs: 10000,
      config: {
        url: 'https://example.com/',
        method: 'GET',
        assertions: [
          { source: 'status', comparison: 'lt', target: 300 },
          { source: 'latency', comparison: 'lt', target: 2000 },
        ],
      },
    },
  },
  {
    id: 'http-json-health',
    name: 'JSON health endpoint',
    description: 'Check a health endpoint returns {"status":"ok"}.',
    check: {
      type: 'http',
      intervalSeconds: 60,
      timeoutMs: 5000,
      config: {
        url: 'https://example.com/api/health',
        method: 'GET',
        headers: { Accept: 'application/json' },
        assertions: [
          { source: 'status', comparison: 'eq', target: 200 },
          { source: 'header', property: 'content-type', comparison: 'contains', target: 'application/json' },
          { source: 'json', property: '$.status', comparison: 'eq', target: 'ok' },
        ],
      },
    },
  },
  {
    id: 'multistep-login',
    name: 'Multi-step: login then fetch profile',
    description: 'POST credentials (stored as check secrets), extract a token, call an authenticated endpoint.',
    check: {
      type: 'multistep',
      intervalSeconds: 300,
      timeoutMs: 30000,
      config: {
        variables: {},
        steps: [
          {
            name: 'Login',
            method: 'POST',
            url: 'https://example.com/api/login',
            headers: { 'Content-Type': 'application/json' },
            body: '{"email":"{{secret.USER}}","password":"{{secret.PASSWORD}}"}',
            assertions: [{ source: 'status', comparison: 'eq', target: 200 }],
            extract: [{ name: 'token', source: 'json', property: '$.token' }],
          },
          {
            name: 'Profile',
            method: 'GET',
            url: 'https://example.com/api/me',
            headers: { Authorization: 'Bearer {{token}}' },
            assertions: [
              { source: 'status', comparison: 'eq', target: 200 },
              { source: 'json', property: '$.email', comparison: 'exists' },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'ssl-expiry',
    name: 'SSL certificate expiry',
    description: 'Warn 14 days before the certificate expires; fail when it is expired or untrusted.',
    check: { type: 'ssl', intervalSeconds: 3600, timeoutMs: 10000, config: { host: 'example.com', port: 443, warnDays: 14, criticalDays: 0 } },
  },
  {
    id: 'browser-smoke',
    name: 'Browser: page loads',
    description: 'Headless Chromium (full profile): open your page, expect HTTP < 400 and a rendered body. Enter your URL first. A screenshot is stored when it fails.',
    /** Fields the user must fill in before saving (the template has no usable default). */
    requiredFields: ['config.steps[0].url'],
    check: {
      type: 'browser',
      intervalSeconds: 900,
      timeoutMs: 60000,
      config: {
        // Target-agnostic: goto fails on HTTP >= 400; no assumptions about headings or text.
        steps: [
          { action: 'goto', url: '' },
          { action: 'wait_for', selector: 'body' },
        ],
      },
    },
  },
];
