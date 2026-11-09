// node api.mjs health|login
import { apiUrl, domain, expect, login, main, request, retry } from './common.mjs';

const mode = process.argv[2];

await main(async () => {
  if (mode === 'health') {
    const live = await retry(async () => {
      const r = await request(`${apiUrl()}/api/health`);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return r;
    });
    expect(live.status === 200, 'API liveness', `HTTP ${live.status}`);
    const ready = await retry(async () => {
      const r = await request(`${apiUrl()}/api/health/ready`);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return r;
    }, { attempts: 24 });
    expect(ready.status === 200, 'API readiness', `HTTP ${ready.status}`);
    const portal = await request(`https://${domain()}/`);
    expect(portal.status === 200 && /<html/i.test(portal.text), 'portal serves the app', `HTTP ${portal.status}`);
    const viaPortal = await request(`https://${domain()}/api/health`);
    expect(viaPortal.status === 200, 'API reachable on the portal host', `HTTP ${viaPortal.status}`);
  } else if (mode === 'login') {
    const token = await login();
    expect(Boolean(token), 'admin login returns a token');
    const me = await request(`${apiUrl()}/api/users/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(me.status === 200, 'authenticated profile request', `HTTP ${me.status}`);
    const wrong = await request(`${apiUrl()}/api/auth/login`, { method: 'POST', body: { email: process.env.ADMIN_EMAIL, password: 'wrong-password-e2e' } });
    expect(wrong.status === 401 || wrong.status === 400 || wrong.status === 429, 'wrong password rejected', `HTTP ${wrong.status}`);
  } else {
    throw new Error('usage: api.mjs health|login');
  }
});
