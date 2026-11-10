// Private seed state includes a pre-upgrade JWT; never upload this file.
import { readFileSync, writeFileSync } from 'node:fs';
import { apiUrl, domain, expect, login, main, request } from './common.mjs';
const [mode, file] = process.argv.slice(2);
const payload = 'platform upgrade e2e object\n';
await main(async () => {
  let state;
  if (mode === 'seed') {
    const token = await login();
    const headers = { authorization: `Bearer ${token}` };
    const name = `e2e-upgrade-${Date.now().toString(36)}`;
    const p = await request(`${apiUrl()}/api/projects`, { method: 'POST', headers,
      body: { name, stack: 'nodejs', domain: domain(), description: 'upgrade persistence seed', repositoryUrl: 'https://github.com/Mpratyush54/server-automation' } });
    if (!expect(p.status === 201 && p.json?.id, 'create seed project')) return;
    const projectId = p.json.id;
    const s = await request(`${apiUrl()}/api/projects/${projectId}/secrets`, { method: 'POST', headers,
      body: { key: 'UPGRADE_E2E', value: 'upgrade-e2e-sentinel' } });
    if (!expect(s.status === 201 && s.json?.id, 'create seed secret')) return;
    const u = await request(`${apiUrl()}/api/storage/upload-url`, { method: 'POST', headers,
      body: { projectId, fileName: 'upgrade.txt', mimeType: 'text/plain' } });
    if (!expect(u.status === 201 && u.json?.fileId, 'register MinIO object')) return;
    const put = await fetch(`${apiUrl()}/api/storage/upload-raw/${u.json.fileId}`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: payload,
      signal: AbortSignal.timeout(30000),
    });
    if (!expect(put.status === 200, 'write seed object')) return;
    state = { token, projectId, name, secretId: s.json.id, fileId: u.json.fileId };
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  } else if (mode === 'verify') {
    state = JSON.parse(readFileSync(file, 'utf8'));
    expect(Boolean(await login()), 'admin can log in after upgrade');
  } else throw new Error('usage: upgrade-seed.mjs seed|verify <private-state.json>');
  const headers = { authorization: `Bearer ${state.token}` };
  const me = await request(`${apiUrl()}/api/users/me`, { headers });
  expect(me.status === 200, 'original admin session valid');
  const p = await request(`${apiUrl()}/api/projects/${state.projectId}`, { headers });
  expect(p.status === 200 && p.json?.name === state.name, 'seed project intact');
  const secrets = await request(`${apiUrl()}/api/projects/${state.projectId}/secrets`, { headers });
  expect(secrets.status === 200 && secrets.json?.some((s) => s.id === state.secretId && s.key === 'UPGRADE_E2E' && s.version === 1 && s.maskedValue === '***'), 'seed secret intact');
  const files = await request(`${apiUrl()}/api/storage/project/${state.projectId}`, { headers });
  expect(files.status === 200 && files.json?.some((f) => f.id === state.fileId && f.provider === 'minio'), 'seed object stored in MinIO');
  const object = await request(`${apiUrl()}/api/storage/file/${state.fileId}`, { headers });
  expect(object.status === 200 && object.text === payload, 'seed object content intact');
});
