// node db-credentials.mjs fetch <out.json>
// node db-credentials.mjs verify postgres|mongo|redis <in.json>
//
// fetch: creates a project and SDK token as the admin, then asks the SDK
// endpoint for per-project credentials of every engine (written 0600 to the
// private work dir; never printed).
// verify: connects with those credentials through `kubectl port-forward`
// (KUBECONFIG points at the VM through an SSH tunnel) using the drivers from
// platform/api/node_modules, and checks the account is scoped to the project.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiUrl, domain, expect, login, main, request, retry } from './common.mjs';

const [mode, a, b] = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(path.join(root, 'platform/api/package.json'));

async function fetchCreds(out) {
  const token = await login();
  const auth = { authorization: `Bearer ${token}` };
  const name = `e2e-db-${Date.now().toString(36)}`;
  const p = await request(`${apiUrl()}/api/projects`, { method: 'POST', headers: auth, body: { name, stack: 'nodejs', domain: domain(), description: 'e2e database credentials', repositoryUrl: 'https://github.com/Mpratyush54/server-automation' } });
  if (!expect(p.status === 201 && p.json?.id, 'create project', `HTTP ${p.status}`)) return;
  const t = await request(`${apiUrl()}/api/projects/${p.json.id}/tokens`, { method: 'POST', headers: auth, body: { name: 'e2e-db' } });
  const sdkToken = t.json?.token;
  if (!expect(t.status === 201 && sdkToken, 'create SDK token', `HTTP ${t.status}`)) return;
  // Provisioning the per-project databases can take a little while.
  const creds = await retry(async () => {
    const r = await request(`${apiUrl()}/api/sdk/db-credentials?projectId=${encodeURIComponent(p.json.id)}&dbTypes=postgres,mongo,redis&environment=development`, { headers: { authorization: `Bearer ${sdkToken}` }, timeoutMs: 120000 });
    if (r.status !== 200 || !r.json) throw new Error(`HTTP ${r.status}`);
    if (['postgres', 'mongo', 'redis'].some((e) => r.json[e]?.status === 'error')) throw new Error('not ready');
    return r.json;
  }, { attempts: 10, delayMs: 10000 }).catch((e) => { expect(false, 'SDK returns credentials for every engine', e.message); return null; });
  if (!creds) return;
  for (const e of ['postgres', 'mongo', 'redis']) expect(creds[e] && creds[e].status !== 'error', `SDK returns ${e} credentials`, 'missing');
  writeFileSync(out, JSON.stringify({ projectId: p.json.id, projectName: name, ...creds }), { mode: 0o600 });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

/** host like "<svc>.<namespace>.svc.cluster.local" -> local forwarded port. */
/** "<pod>.<headless-svc>.<namespace>.svc..." (replica-set member) forwards the pod. */
async function forward(host, port) {
  const parts = String(host).split('.');
  const member = parts.length > 2 && parts[1].endsWith('-headless');
  const [target, ns] = member ? [`pod/${parts[0]}`, parts[2]] : [`svc/${parts[0]}`, parts[1]];
  if (!parts[0] || !ns) throw new Error('unexpected database host format');
  const local = await freePort();
  const child = spawn('kubectl', ['-n', ns, 'port-forward', target, `${local}:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('port-forward timeout')), 30000);
    child.stdout.on('data', (d) => { if (/Forwarding from/.test(String(d))) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`port-forward exited ${code}`)); });
  });
  return { local, stop: () => child.kill() };
}

async function verify(engine, file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  if (engine === 'postgres') {
    const pg = c.postgres;
    const { Client } = apiRequire('pg');
    const f = await forward(pg.host, pg.port || 5432);
    try {
      const client = new Client({ host: '127.0.0.1', port: f.local, user: pg.user, password: pg.password, database: pg.database, connectionTimeoutMillis: 15000 });
      await client.connect();
      const r = await client.query('select current_user as u, current_database() as d, (select rolsuper from pg_roles where rolname = current_user) as su');
      expect(r.rows[0].u === pg.user && r.rows[0].d === pg.database, 'postgres: project credentials authenticate', 'wrong identity');
      expect(r.rows[0].su === false, 'postgres: project role is not a superuser', 'superuser');
      await client.query('create table if not exists e2e_probe (id int)');
      await client.query('insert into e2e_probe values (1)');
      expect((await client.query('select count(*)::int as n from e2e_probe')).rows[0].n >= 1, 'postgres: read/write in the project database', 'no rows');
      await client.end();
      const wrong = new Client({ host: '127.0.0.1', port: f.local, user: pg.user, password: `${pg.password}x`, database: pg.database, connectionTimeoutMillis: 15000 });
      const rejected = await wrong.connect().then(() => wrong.end().then(() => false), () => true);
      expect(rejected, 'postgres: wrong password rejected', 'accepted');
    } finally { f.stop(); }
  } else if (engine === 'mongo') {
    const m = c.mongo;
    const mongoose = apiRequire('mongoose');
    // ha returns a replica-set URI (mongodb://u:p@m0,m1,m2/db?replicaSet=rs0),
    // which WHATWG URL rejects: split the host list off and forward each
    // member until the writable primary answers.
    const mu = /^(mongodb:\/\/)([^@/]+@)?([^/?]+)(.*)$/.exec(m.uri);
    if (!mu) throw new Error('unexpected mongo uri format');
    let f; let conn;
    for (const hostPort of mu[3].split(',')) {
      const [host, port] = hostPort.split(':');
      const fw = await forward(host, Number(port || 27017));
      const uri = new URL(`${mu[1]}${mu[2] || ''}127.0.0.1:${fw.local}${mu[4]}`);
      uri.searchParams.set('directConnection', 'true');
      uri.searchParams.delete('replicaSet');
      const c = await mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 15000 }).asPromise().catch(() => null);
      const primary = c && (await c.db.admin().command({ hello: 1 }).then((h) => h.isWritablePrimary, () => false));
      if (primary) { f = fw; conn = c; break; }
      if (c) await c.close();
      fw.stop();
    }
    if (!expect(conn, 'mongo: a replica-set member answers as writable primary', 'none')) return;
    try {
      const col = conn.db.collection('e2e_probe');
      await col.insertOne({ at: new Date() });
      expect((await col.countDocuments()) >= 1, 'mongo: project credentials read/write their database', 'no documents');
      const other = await conn.useDb('e2e_foreign_db').collection('probe').insertOne({ x: 1 }).then(() => true, () => false);
      expect(!other, 'mongo: project user cannot write other databases', 'allowed');
      await conn.close();
    } finally { f.stop(); }
  } else if (engine === 'redis') {
    const r = c.redis;
    const Redis = apiRequire('ioredis');
    const f = await forward(r.host, r.port || 6379);
    try {
      const client = new Redis({ host: '127.0.0.1', port: f.local, username: r.username || undefined, password: r.password, lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 15000 });
      await client.connect();
      const prefix = r.keyPrefix || '';
      await client.set(`${prefix}e2e-probe`, '1', 'EX', 60);
      expect((await client.get(`${prefix}e2e-probe`)) === '1', 'redis: project credentials read/write their key prefix', 'no value');
      if (prefix) {
        const outside = await client.set('e2e-outside-prefix', '1', 'EX', 60).then(() => true, () => false);
        expect(!outside, 'redis: keys outside the project prefix are denied', 'allowed');
      }
      client.disconnect();
    } finally { f.stop(); }
  } else {
    throw new Error('engine must be postgres, mongo or redis');
  }
}

await main(async () => {
  if (mode === 'fetch' && a) await fetchCreds(a);
  else if (mode === 'verify' && a && b) await verify(a, b);
  else throw new Error('usage: db-credentials.mjs fetch <out> | verify <engine> <in>');
});
