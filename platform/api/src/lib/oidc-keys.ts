import * as crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * RS256 signing key for the built-in OIDC provider.
 *
 * Resolution order:
 *  1. OIDC_SIGNING_KEY (PKCS#8 / PKCS#1 PEM, literal "\n" escapes accepted)
 *  2. OIDC_SIGNING_KEY_FILE (default /etc/platform/oidc-signing-key.pem) if it exists
 *  3. Generate once and persist to that file (mode 0600) when the directory is writable
 *  4. In-memory only, with a warning (tokens become invalid on restart)
 */
export interface OidcSigningKey {
  privateKey: string;
  publicKey: string;
  kid: string;
  source: 'env' | 'file' | 'generated-file' | 'memory';
}

export const DEFAULT_SIGNING_KEY_FILE = '/etc/platform/oidc-signing-key.pem';

let current: OidcSigningKey | null = null;

function fromPrivatePem(pem: string, source: OidcSigningKey['source']): OidcSigningKey {
  const keyObj = crypto.createPrivateKey(pem);
  if (keyObj.asymmetricKeyType !== 'rsa') {
    throw new Error('OIDC signing key must be an RSA private key');
  }
  const privateKey = keyObj.export({ type: 'pkcs8', format: 'pem' }).toString();
  const pubObj = crypto.createPublicKey(keyObj);
  const publicKey = pubObj.export({ type: 'spki', format: 'pem' }).toString();
  const jwk = pubObj.export({ format: 'jwk' }) as { e: string; n: string };
  // RFC 7638 JWK thumbprint → stable kid that changes when the key changes.
  const thumb = crypto
    .createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n }))
    .digest('base64url');
  return { privateKey, publicKey, kid: thumb.slice(0, 16), source };
}

function generatePem(): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return privateKey;
}

export function loadOidcSigningKey(): OidcSigningKey {
  const envPem = (process.env.OIDC_SIGNING_KEY || '').replace(/\\n/g, '\n').trim();
  if (envPem) {
    return fromPrivatePem(envPem, 'env');
  }

  // Test runs must never touch the host's /etc/platform unless a file is set explicitly.
  if (process.env.NODE_ENV === 'test' && !process.env.OIDC_SIGNING_KEY_FILE) {
    return fromPrivatePem(generatePem(), 'memory');
  }

  const file = process.env.OIDC_SIGNING_KEY_FILE || DEFAULT_SIGNING_KEY_FILE;
  try {
    if (fs.existsSync(file)) {
      return fromPrivatePem(fs.readFileSync(file, 'utf8'), 'file');
    }
  } catch (err: any) {
    console.error(`[oidc] Could not read signing key ${file}: ${err.message}`);
  }

  const pem = generatePem();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 'wx' — never clobber a key another replica wrote in the meantime.
    fs.writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
    console.log(`[oidc] Generated RSA-2048 signing key and stored it at ${file}.`);
    return fromPrivatePem(pem, 'generated-file');
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      try {
        return fromPrivatePem(fs.readFileSync(file, 'utf8'), 'file');
      } catch {
        /* fall through to memory */
      }
    }
    console.warn(
      `[oidc] WARNING: could not persist signing key to ${file} (${err?.message || err}). ` +
        'Using an in-memory key — OIDC sessions break on every restart. Set OIDC_SIGNING_KEY.',
    );
    return fromPrivatePem(pem, 'memory');
  }
}

export function getOidcSigningKey(): OidcSigningKey {
  if (!current) current = loadOidcSigningKey();
  return current;
}

/** Test hook. */
export function resetOidcSigningKey(): void {
  current = null;
}
