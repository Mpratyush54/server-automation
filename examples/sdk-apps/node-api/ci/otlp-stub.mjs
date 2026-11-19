// Stub Cairn API + OTLP collector for the demo image's trace check (CI only).
//   node otlp-stub.mjs <dir with key.pem and cert.pem> <port>
// GET /api/sdk/config hands the SDK a telemetry block that points back at this
// server; every OTLP export is logged as "OTLP <path> <bytes>". All other SDK
// calls (register, heartbeat, metrics, logs) get an empty 200.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';

const [dir, port = '8443'] = process.argv.slice(2);
const origin = `https://localhost:${port}`;

const server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
  let bytes = 0;
  req.on('data', (chunk) => { bytes += chunk.length; });
  req.on('end', () => {
    const path = (req.url || '/').split('?')[0];
    if (path.startsWith('/v1/')) console.log(`OTLP ${path} ${bytes}`);
    else console.log(`${req.method} ${path}`);
    let body = {};
    if (req.method === 'GET' && path === '/api/sdk/config') {
      body = {
        telemetry: {
          enabled: true,
          otlpEndpoint: origin,
          profilesEndpoint: null,
          faroEndpoint: null,
          ingestToken: 'ci-ingest-token',
          ingestTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          browserToken: null,
          samplingRatio: 1,
          resource: { 'platform.project_id': 'ci', 'deployment.environment': 'development' },
        },
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});
server.listen(Number(port), '127.0.0.1', () => console.log(`stub listening on ${origin}`));
