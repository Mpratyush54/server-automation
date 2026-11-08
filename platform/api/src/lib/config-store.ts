import fs from 'fs';
import path from 'path';
import { platformCredDir, platformEnvFile, upsertDotEnvFile, writeFileAtomic } from './host-env';

/**
 * Where the API keeps configuration it changes at runtime (rotated passwords,
 * write-ahead copies, the OIDC signing key).
 *
 *  - KubeSecretStore: a named Kubernetes Secret, updated through the API with
 *    optimistic concurrency (resourceVersion) — what runs in the cluster.
 *  - FileStore: a dotenv file (plus optional per-key files) — dev and tests.
 *
 * The running API never depends on the node filesystem; the host files that
 * platformctl keeps under /etc/platform are an operator-side break-glass copy.
 */
export interface ConfigStore {
  readonly description: string;
  read(): Promise<Record<string, string>>;
  /** Merge `values` into the store. Empty values are ignored (never erase). */
  patch(values: Record<string, string>): Promise<void>;
  /**
   * Create the store with `values` unless it already exists; returns the
   * stored values either way (the existing ones win — handles concurrent creators).
   */
  createIfAbsent(values: Record<string, string>): Promise<Record<string, string>>;
}

export const PLATFORM_NAMESPACE = process.env.PLATFORM_NAMESPACE || 'platform';
export const PLATFORM_ENV_SECRET = 'platform-env';
export const PLATFORM_CREDENTIALS_SECRET = 'platform-credentials';
export const PLATFORM_OIDC_KEY_SECRET = 'platform-oidc-signing-key';

/** Credential keys that live in platform-credentials (not platform-env). */
export const CREDENTIAL_KEYS = [
  'ADMIN_PASSWORD',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'MONGODB_URI',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
] as const;

/** Subset of CoreV1Api used here; injectable for tests. */
export interface SecretApi {
  readNamespacedSecret(p: { name: string; namespace: string }): Promise<any>;
  replaceNamespacedSecret(p: { name: string; namespace: string; body: any }): Promise<any>;
  createNamespacedSecret(p: { namespace: string; body: any }): Promise<any>;
}

/** HTTP status of a Kubernetes client error (client-node 0.x and 1.x shapes). */
export function k8sStatusCode(err: any): number | undefined {
  for (const c of [err?.code, err?.statusCode, err?.response?.statusCode, err?.body?.code]) {
    if (typeof c === 'number') return c;
  }
  return undefined;
}

function decodeData(secret: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(secret?.data || {})) {
    out[k] = Buffer.from(String(v), 'base64').toString('utf8');
  }
  for (const [k, v] of Object.entries(secret?.stringData || {})) {
    out[k] = String(v);
  }
  return out;
}

function nonEmpty(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

export class KubeSecretStore implements ConfigStore {
  readonly description: string;

  constructor(
    private readonly api: SecretApi,
    readonly namespace: string,
    readonly name: string,
    private readonly maxAttempts = 5,
  ) {
    this.description = `secret ${namespace}/${name}`;
  }

  private async readRaw(): Promise<any | null> {
    try {
      const res: any = await this.api.readNamespacedSecret({ name: this.name, namespace: this.namespace });
      return res?.body ?? res;
    } catch (err) {
      if (k8sStatusCode(err) === 404) return null;
      throw err;
    }
  }

  private async create(values: Record<string, string>): Promise<boolean> {
    try {
      await this.api.createNamespacedSecret({
        namespace: this.namespace,
        body: {
          apiVersion: 'v1',
          kind: 'Secret',
          type: 'Opaque',
          metadata: {
            name: this.name,
            namespace: this.namespace,
            labels: { 'app.kubernetes.io/managed-by': 'platform-api' },
          },
          stringData: values,
        },
      });
      return true;
    } catch (err) {
      if (k8sStatusCode(err) === 409) return false;
      throw err;
    }
  }

  async read(): Promise<Record<string, string>> {
    const secret = await this.readRaw();
    return secret ? decodeData(secret) : {};
  }

  async patch(values: Record<string, string>): Promise<void> {
    const data = nonEmpty(values);
    if (Object.keys(data).length === 0) return;
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const secret = await this.readRaw();
      if (!secret) {
        if (await this.create(data)) return;
        continue; // someone else created it — merge into theirs
      }
      const body = { ...secret, data: { ...(secret.data || {}) } };
      delete body.stringData;
      for (const [k, v] of Object.entries(data)) {
        body.data[k] = Buffer.from(v, 'utf8').toString('base64');
      }
      try {
        // metadata.resourceVersion from the read makes this a compare-and-swap.
        await this.api.replaceNamespacedSecret({ name: this.name, namespace: this.namespace, body });
        return;
      } catch (err) {
        if (k8sStatusCode(err) !== 409) throw err;
        lastErr = err;
      }
    }
    throw new Error(
      `${this.description}: gave up after ${this.maxAttempts} conflicting updates (${(lastErr as any)?.message || 'conflict'})`,
    );
  }

  async createIfAbsent(values: Record<string, string>): Promise<Record<string, string>> {
    const existing = await this.readRaw();
    if (existing) return decodeData(existing);
    if (await this.create(nonEmpty(values))) return nonEmpty(values);
    return this.read(); // 409: another replica won the race
  }
}

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1);
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/**
 * Dotenv-backed store for local development and tests. When `keyFiles` is
 * given, those keys are also written to one 0600 file each under `credDir`
 * (the historical /etc/platform/credentials layout); `envKeys` limits which
 * keys go into the dotenv file (all when omitted).
 */
export class FileStore implements ConfigStore {
  readonly description: string;

  constructor(
    readonly envFile: string,
    private readonly opts: { credDir?: string; keyFiles?: Record<string, string>; envKeys?: string[] } = {},
  ) {
    this.description = opts.credDir ? `${envFile} and ${opts.credDir}` : envFile;
  }

  async read(): Promise<Record<string, string>> {
    let text = '';
    try {
      text = fs.readFileSync(this.envFile, 'utf8');
    } catch {
      text = '';
    }
    const out = parseDotEnv(text);
    const { credDir, keyFiles } = this.opts;
    if (credDir && keyFiles) {
      for (const [key, file] of Object.entries(keyFiles)) {
        if (out[key]) continue;
        try {
          const v = fs.readFileSync(path.join(credDir, file), 'utf8').trim();
          if (v) out[key] = v;
        } catch {
          /* absent */
        }
      }
    }
    return out;
  }

  async patch(values: Record<string, string>): Promise<void> {
    const data = nonEmpty(values);
    const { credDir, keyFiles, envKeys } = this.opts;
    if (credDir && keyFiles) {
      fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
      for (const [key, file] of Object.entries(keyFiles)) {
        if (data[key]) writeFileAtomic(path.join(credDir, file), `${data[key]}\n`);
      }
    }
    const envPatch: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!envKeys || envKeys.includes(k)) envPatch[k] = v;
    }
    if (Object.keys(envPatch).length > 0) upsertDotEnvFile(this.envFile, envPatch);
  }

  async createIfAbsent(values: Record<string, string>): Promise<Record<string, string>> {
    const existing = await this.read();
    if (Object.keys(existing).length > 0) return existing;
    await this.patch(values);
    return nonEmpty(values);
  }
}

/**
 * Kubernetes Secrets in the cluster; files elsewhere. PLATFORM_CONFIG_STORE
 * (kube|file) overrides; tests default to files.
 */
export function useKubeConfigStore(): boolean {
  const mode = (process.env.PLATFORM_CONFIG_STORE || '').toLowerCase();
  if (mode === 'kube') return true;
  if (mode === 'file') return false;
  return !!process.env.KUBERNETES_SERVICE_HOST && process.env.NODE_ENV !== 'test';
}

let secretApi: SecretApi | null = null;

/** Lazily built so importing this module never needs a kubeconfig. */
async function defaultSecretApi(): Promise<SecretApi> {
  if (!secretApi) {
    const k8s = await import('@kubernetes/client-node');
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
    secretApi = kc.makeApiClient(k8s.CoreV1Api) as unknown as SecretApi;
  }
  return secretApi;
}

/** Test hook. */
export function setSecretApiForTests(api: SecretApi | null): void {
  secretApi = api;
}

const CREDENTIAL_FILES: Record<string, string> = {
  POSTGRES_PASSWORD: 'postgres',
  REDIS_PASSWORD: 'redis',
  ADMIN_PASSWORD: 'admin',
  POSTGRES_PASSWORD_PREV: 'postgres.prev',
  POSTGRES_PASSWORD_NEXT: 'postgres.next',
  REDIS_PASSWORD_PREV: 'redis.prev',
  REDIS_PASSWORD_NEXT: 'redis.next',
};

/** Admin + datastore credentials (and rotation write-ahead copies). */
export async function credentialsStore(): Promise<ConfigStore> {
  if (useKubeConfigStore()) {
    return new KubeSecretStore(await defaultSecretApi(), PLATFORM_NAMESPACE, PLATFORM_CREDENTIALS_SECRET);
  }
  return new FileStore(platformEnvFile(), {
    credDir: platformCredDir(),
    keyFiles: CREDENTIAL_FILES,
    envKeys: ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'ADMIN_PASSWORD'],
  });
}

/** Non-credential platform configuration (envFrom'd into the API). */
export async function platformEnvStore(): Promise<ConfigStore> {
  if (useKubeConfigStore()) {
    return new KubeSecretStore(await defaultSecretApi(), PLATFORM_NAMESPACE, PLATFORM_ENV_SECRET);
  }
  return new FileStore(platformEnvFile());
}

/** Kubernetes Secret holding the OIDC signing key (cluster only). */
export async function oidcKeySecretStore(): Promise<ConfigStore> {
  const name = process.env.OIDC_SIGNING_KEY_SECRET || PLATFORM_OIDC_KEY_SECRET;
  return new KubeSecretStore(await defaultSecretApi(), PLATFORM_NAMESPACE, name);
}
