// node tls.mjs <platform-ca.pem|-> <mode-out-file> [host...]
// Each host must present a certificate that is valid now (and for at least
// another day), matches the host name and chains to the public trust store or,
// when the platform fell back to it, the platform's internal CA. Writes
// "public" or "platform-ca" to <mode-out-file> for the later checks.
// E2E_REQUIRE_PUBLIC_TLS=1 fails unless every host has a publicly trusted cert.
import tls from 'node:tls';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { bad, expect, main, ok } from './common.mjs';

const [caFile, modeOut, ...hosts] = process.argv.slice(2);
const platformCA = caFile && caFile !== '-' && existsSync(caFile) ? readFileSync(caFile, 'utf8') : '';

function probe(host, ca) {
  return new Promise((resolve) => {
    const opts = { host, port: 443, servername: host, rejectUnauthorized: false, timeout: 15000 };
    if (ca) opts.ca = ca;
    const s = tls.connect(opts, () => {
      const cert = s.getPeerCertificate();
      resolve({ authorized: s.authorized, error: s.authorizationError, cert });
      s.end();
    });
    s.on('error', (e) => resolve({ authorized: false, error: e.message, cert: null }));
    s.on('timeout', () => { s.destroy(); resolve({ authorized: false, error: 'timeout', cert: null }); });
  });
}

async function check(host) {
  // cert-manager may still be finishing the order right after provision.
  for (let i = 0; i < 18; i++) {
    const pub = await probe(host);
    if (pub.authorized) return { mode: 'public', cert: pub.cert };
    if (platformCA) {
      const own = await probe(host, platformCA);
      if (own.authorized) return { mode: 'platform-ca', cert: own.cert };
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  return { mode: 'untrusted', cert: (await probe(host)).cert };
}

await main(async () => {
  const modes = new Set();
  for (const host of hosts) {
    const { mode, cert } = await check(host);
    if (mode === 'untrusted' || !cert?.valid_to) {
      bad(`${host}: trusted certificate`, 'not trusted by the public store or the platform CA');
      continue;
    }
    modes.add(mode);
    ok(`${host}: trusted certificate (${mode === 'public' ? 'public CA' : 'platform internal CA'})`);
    expect(tls.checkServerIdentity(host, cert) === undefined, `${host}: certificate matches host name`, 'name mismatch');
    const remainingDays = (new Date(cert.valid_to) - Date.now()) / 86400000;
    expect(new Date(cert.valid_from) <= new Date() && remainingDays > 1, `${host}: certificate within validity period`, `${remainingDays.toFixed(1)} days left`);
  }
  const mode = modes.has('platform-ca') ? 'platform-ca' : 'public';
  if (modeOut) writeFileSync(modeOut, `${mode}\n`);
  if (process.env.E2E_REQUIRE_PUBLIC_TLS === '1') expect(mode === 'public', 'publicly trusted certificates required', mode);
});
