import * as crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ConfigStore } from './config-store';

/**
 * RS256 signing key for the built-in OIDC provider.
 *
 * Resolution order:
 *  1. OIDC_SIGNING_KEY (PKCS#8 / PKCS#1 PEM, literal "
" escapes accepted)
 *  2. In the cluster: the `platform-oidc-signing-key` Secret (keys
 *     `private.pem`, `kid`, and after a rotation `previous.pem`/`previous-kid`).
 *     Created on first boot if absent (create-if-not-exists; a 409 means
 *     another replica won, and its key is used) — so every replica and every
 *     restart signs with the same key. Call initOidcSigningKey() at boot.
 *  3. Dev/tests: OIDC_SIGNING_KEY_FILE (default /etc/platform/oidc-signing-key.pem),
 *     generated once when the directory is writable
 *  4. In-memory only, with a warning (tokens become invalid on restart)
 */
export interface OidcSigningKey {
  privateKey: string;
  publicKey: string;
  kid: string;
  source: 'env' | 'secret' | 'generated-secret' | 'file' | 'generated-file' | 'memory';
}

export const SECRET_PRIVATE_KEY = 'private.pem';
export const SECRET_KID = 'kid';
export const SECRET_PREVIOUS_KEY = 'previous.pem';
export const SECRET_PREVIOUS_KID = 'previous-kid';

export const DEFAULT_SIGNING_KEY_FILE = '/etc/platform/oidc-signing-key.pem';

let current: OidcSigningKey | null = null;
/** Key retired by the last rotation; still published in JWKS and accepted for verification. */
let previous: OidcSigningKey | null = null;

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

/**
 * Load (or create) the signing key from a Kubernetes Secret store.
 * Exported for tests; production code calls initOidcSigningKey().
 */
export async function loadOidcSigningKeyFromStore(
  store: ConfigStore,
): Promise<{ key: OidcSigningKey; previous: OidcSigningKey | null }> {
  let data = await store.read();
  let source: OidcSigningKey['source'] = 'secret';
  if (!data[SECRET_PRIVATE_KEY]) {
    const candidate = fromPrivatePem(generatePem(), 'generated-secret');
    data = await store.createIfAbsent({ [SECRET_PRIVATE_KEY]: candidate.privateKey, [SECRET_KID]: candidate.kid });
    source = data[SECRET_PRIVATE_KEY] === candidate.privateKey ? 'generated-secret' : 'secret';
    if (source === 'generated-secret') {
      console.log(`[oidc] Generated RSA-2048 signing key and stored it in ${store.description}.`);
    }
  }
  if (!data[SECRET_PRIVATE_KEY]) {
    throw new Error(`${store.description} has no ${SECRET_PRIVATE_KEY}`);
  }
  const key = fromPrivatePem(data[SECRET_PRIVATE_KEY], source);
  let prev: OidcSigningKey | null = null;
  if (data[SECRET_PREVIOUS_KEY]) {
    try {
      prev = fromPrivatePem(data[SECRET_PREVIOUS_KEY], 'secret');
    } catch (err: any) {
      console.warn(`[oidc] ignoring unreadable previous signing key: ${err?.message || err}`);
    }
  }
  return { key, previous: prev };
}

async function defaultKeyStore(): Promise<ConfigStore | null> {
  const { useKubeConfigStore, oidcKeySecretStore } = await import('./config-store');
  return useKubeConfigStore() ? oidcKeySecretStore() : null;
}

/**
 * Resolve the signing key once at boot. In the cluster this reads/creates the
 * Secret; elsewhere it uses the env/file/memory chain. Never throws: if the
 * Secret cannot be reached the API still starts (with a loud warning).
 */
export async function initOidcSigningKey(store?: ConfigStore | null): Promise<OidcSigningKey> {
  if ((process.env.OIDC_SIGNING_KEY || '').trim()) {
    current = loadOidcSigningKey();
    previous = null;
    return current;
  }
  const target = store === undefined ? await defaultKeyStore() : store;
  if (target) {
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const loaded = await loadOidcSigningKeyFromStore(target);
        current = loaded.key;
        previous = loaded.previous;
        return current;
      } catch (err: any) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    console.error(
      `[oidc] WARNING: could not load the signing key from ${target.description} (${lastErr?.message || lastErr}). ` +
        'Falling back to a local key — OIDC sessions will not survive restarts or span replicas.',
    );
  }
  current = loadOidcSigningKey();
  previous = null;
  return current;
}

/**
 * Rotate: generate a new key, keep the current one as `previous` (published
 * in JWKS and accepted for verification until the next rotation). Other
 * replicas pick the new key up on restart (the caller restarts the API).
 */
export async function rotateOidcSigningKey(store?: ConfigStore | null): Promise<OidcSigningKey> {
  const target = store === undefined ? await defaultKeyStore() : store;
  if (!target) throw new Error('OIDC key rotation needs the Kubernetes Secret store');
  const { key: old } = await loadOidcSigningKeyFromStore(target);
  const next = fromPrivatePem(generatePem(), 'secret');
  await target.patch({
    [SECRET_PRIVATE_KEY]: next.privateKey,
    [SECRET_KID]: next.kid,
    [SECRET_PREVIOUS_KEY]: old.privateKey,
    [SECRET_PREVIOUS_KID]: old.kid,
  });
  current = next;
  previous = { ...old, source: 'secret' };
  return next;
}

export function getOidcSigningKey(): OidcSigningKey {
  if (!current) current = loadOidcSigningKey();
  return current;
}

/** Keys to publish in JWKS and to accept when verifying: current first, then previous. */
export function getOidcVerificationKeys(): OidcSigningKey[] {
  const keys = [getOidcSigningKey()];
  if (previous && previous.kid !== keys[0].kid) keys.push(previous);
  return keys;
}

/** Test hook. */
export function resetOidcSigningKey(): void {
  current = null;
  previous = null;
}
