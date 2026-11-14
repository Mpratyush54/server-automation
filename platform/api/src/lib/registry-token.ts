import crypto from 'crypto';
import jwt from 'jsonwebtoken';

/**
 * Registry authorization for source builds (#55). The bundled CNCF distribution registry runs
 * in token-auth mode and trusts only JWTs signed by the API. Every token names exact
 * repositories and actions, so one project's identity can never read or write another
 * project's images:
 * - a build's trusted publish step gets push+pull for its own environment repository only;
 * - a project namespace pulls with a per-project credential that the token endpoint exchanges
 *   for short-lived pull-only tokens limited to that project's repositories;
 * - only the API's retention identity is ever granted delete.
 */
export const REGISTRY_SERVICE = 'cairn-registry';
export const REGISTRY_ISSUER = 'cairn-api';
/** Builds and the API reach the registry in-cluster; nothing is published through ingress. */
export const REGISTRY_INTERNAL_HOST = 'registry.registry.svc.cluster.local:5000';
export const REGISTRY_SIGNER_SECRET = 'registry-token-signer';
export const PULL_TOKEN_TTL_SECONDS = 300;

export type RegistryAction = 'pull' | 'push' | 'delete';
export interface RegistryAccess { type: 'repository'; name: string; actions: RegistryAction[] }
interface Signer { key: crypto.KeyObject; kid: string; credentialKey: Buffer }

const ID = '[a-z0-9][a-z0-9-]{0,63}';
const REPOSITORY = new RegExp(`^p-${ID}/e-${ID}$`);

export function buildRepository(projectId: string, environmentId: string): string {
  const name = `p-${projectId}/e-${environmentId}`.toLowerCase();
  if (!REPOSITORY.test(name)) throw new Error('Invalid build repository');
  return name;
}

let cached: { signer: Signer; until: number } | null = null;
let testSigner: Signer | null = null;

/**
 * The registry identifies the signing key by its libtrust key ID ("kid"), derived from the
 * public key of the certificate in its rootcertbundle, so the API only needs the private key.
 */
export function libtrustKeyId(publicKeyDer: Buffer): string {
  const bytes = crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 30);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.match(/.{4}/g)!.join(':');
}

function toSigner(keyPem: string): Signer {
  const key = crypto.createPrivateKey(keyPem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Registry token signer must be an ECDSA P-256 key');
  const kid = libtrustKeyId(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer);
  // A separate derived key: the signing key itself is never used as an HMAC key directly.
  const credentialKey = crypto.createHash('sha256').update('cairn-registry-pull-credential:').update(keyPem).digest();
  return { key, kid, credentialKey };
}

export function setRegistrySignerForTests(keyPem: string | null): void {
  testSigner = keyPem ? toSigner(keyPem) : null;
  cached = null;
}

async function signer(): Promise<Signer> {
  if (testSigner) return testSigner;
  if (cached && cached.until > Date.now()) return cached.signer;
  // Loaded lazily so the pure helpers here (and build-spec) stay free of cluster clients.
  const k8s = await import('@kubernetes/client-node');
  const { loadKubeConfig } = await import('./kube-config');
  const kc = new k8s.KubeConfig();
  loadKubeConfig(kc);
  const res: any = await kc.makeApiClient(k8s.CoreV1Api).readNamespacedSecret({ namespace: 'builds', name: REGISTRY_SIGNER_SECRET });
  const data = (res.body || res).data || {};
  if (!data['key.pem']) throw new Error('Registry token signer is not configured');
  const value = toSigner(Buffer.from(data['key.pem'], 'base64').toString());
  cached = { signer: value, until: Date.now() + 5 * 60 * 1000 };
  return value;
}

export async function mintRegistryToken(subject: string, access: RegistryAccess[], ttlSeconds: number): Promise<string> {
  for (const entry of access) {
    if (entry.type !== 'repository' || !REPOSITORY.test(entry.name) || !entry.actions.length) throw new Error('Invalid registry access');
  }
  const s = await signer();
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iss: REGISTRY_ISSUER, sub: subject, aud: REGISTRY_SERVICE, iat: now, nbf: now - 10, exp: now + ttlSeconds, jti: crypto.randomUUID(), access },
    s.key, { algorithm: 'ES256', header: { alg: 'ES256', typ: 'JWT', kid: s.kid } });
}

/** Push+pull on exactly one environment repository: used only by a build's trusted steps. */
export function buildPushToken(projectId: string, environmentId: string, buildId: string, ttlSeconds: number): Promise<string> {
  return mintRegistryToken(`build:${buildId}`, [{ type: 'repository', name: buildRepository(projectId, environmentId), actions: ['pull', 'push'] }], ttlSeconds);
}

/** The API's own retention identity: the only one that may delete manifests. */
export function retentionToken(repository: string): Promise<string> {
  return mintRegistryToken('cairn-retention', [{ type: 'repository', name: repository, actions: ['pull', 'delete'] }], 120);
}

/** Docker config for crane (registrytoken is sent as a bearer token without a realm round trip). */
export function pushDockerConfig(token: string): string {
  return JSON.stringify({ auths: { [REGISTRY_INTERNAL_HOST]: { registrytoken: token } } });
}

/** CNB_REGISTRY_AUTH for the Buildpacks lifecycle's trusted phases. */
export function pushCnbAuth(token: string): string {
  return JSON.stringify({ [REGISTRY_INTERNAL_HOST]: `Bearer ${token}` });
}

/** Per-project pull credential; deterministic so it needs no storage, rotated with the signing key. */
export async function pullCredential(projectId: string): Promise<{ username: string; password: string }> {
  if (!new RegExp(`^${ID}$`).test(projectId)) throw new Error('Invalid project id');
  const s = await signer();
  return { username: `pull.${projectId}`, password: crypto.createHmac('sha256', s.credentialKey).update(`pull:${projectId}`).digest('base64url') };
}

/** Returns the project id for a valid pull credential, otherwise null. */
export async function verifyPullCredential(username: string, password: string): Promise<string | null> {
  const match = new RegExp(`^pull\\.(${ID})$`).exec(username || '');
  if (!match || typeof password !== 'string' || !password) return null;
  const expected = Buffer.from((await pullCredential(match[1])).password);
  const supplied = Buffer.from(password);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied) ? match[1] : null;
}

/** Grant pull, and only pull, on requested repositories that belong to the project. */
export function pullAccessFor(projectId: string, scopes: string[]): RegistryAccess[] {
  const prefix = `p-${projectId}/`.toLowerCase();
  const granted: RegistryAccess[] = [];
  for (const scope of scopes.flatMap(s => String(s || '').split(' ')).filter(Boolean)) {
    const parts = scope.split(':');
    if (parts.length !== 3 || parts[0] !== 'repository') continue;
    const [, name, actions] = parts;
    if (!REPOSITORY.test(name) || !name.startsWith(prefix) || !actions.split(',').includes('pull')) continue;
    if (!granted.some(g => g.name === name)) granted.push({ type: 'repository', name, actions: ['pull'] });
  }
  return granted;
}
