/**
 * The off-site backup target configured with `platformctl backup target` (#186).
 *
 * platformctl writes a non-secret summary to the ConfigMap platform/platform-backup-target
 * (mode external|local) and the full target, keys included, to the Secret of the same name.
 * Backups that must outlive the cluster (the ones taken before a project is deleted) go here
 * rather than to the bundled MinIO, which lives on the cluster's own disks.
 *
 * Objects written here are recorded in db_backups with providerType s3, no providerId and a
 * fileId of `offsite:<key>`, so a restore reads them back from the same target.
 */
import { inCluster, loadKubeConfig } from './kube-config';
import { S3Adapter, StorageAdapter } from './storage-service';

export const OFFSITE_FILE_PREFIX = 'offsite:';
const NAME = 'platform-backup-target';
const NAMESPACE = 'platform';

export interface OffsiteTarget {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKey: string;
  secretKey: string;
}

const notFound = (err: any) => err?.code === 404 || err?.response?.statusCode === 404 || err?.statusCode === 404;

function decode(data: Record<string, string> | undefined, key: string): string {
  const v = data?.[key];
  return v ? Buffer.from(v, 'base64').toString('utf8').trim() : '';
}

/** Parse the Secret's data (base64 values, as the API returns them). */
export function parseOffsiteSecret(data: Record<string, string> | undefined): OffsiteTarget | null {
  const t: OffsiteTarget = {
    endpoint: decode(data, 'endpoint').replace(/\/+$/, ''),
    bucket: decode(data, 'bucket'),
    region: decode(data, 'region'),
    prefix: decode(data, 'prefix').replace(/^\/+|\/+$/g, ''),
    accessKey: decode(data, 'access-key'),
    secretKey: decode(data, 'secret-key'),
  };
  return t.bucket && t.accessKey && t.secretKey ? t : null;
}

export type OffsiteReader = () => Promise<{ mode: string | null; secret: Record<string, string> | undefined | null }>;

const clusterReader: OffsiteReader = async () => {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  loadKubeConfig(kc);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  let mode: string | null = null;
  try {
    const cm: any = await core.readNamespacedConfigMap({ namespace: NAMESPACE, name: NAME });
    mode = cm?.data?.mode ?? null;
  } catch (err) {
    if (notFound(err)) return { mode: null, secret: null };
    throw err;
  }
  if (mode !== 'external') return { mode, secret: null };
  const secret: any = await core.readNamespacedSecret({ namespace: NAMESPACE, name: NAME });
  return { mode, secret: secret?.data };
};

let reader: OffsiteReader | null = null;
export function setOffsiteReaderForTests(r: OffsiteReader | null): void { reader = r; }

/**
 * The configured off-site target, or null when none is configured. Throws when one is
 * configured but cannot be read, so callers never silently fall back to on-cluster storage.
 */
export async function readOffsiteTarget(): Promise<OffsiteTarget | null> {
  if (!reader && !inCluster()) return null; // local dev: no cluster, no target
  const { mode, secret } = await (reader || clusterReader)();
  if (mode !== 'external') return null;
  const target = parseOffsiteSecret(secret || undefined);
  if (!target) throw new Error('The off-site backup target is configured but its credentials are incomplete');
  return target;
}

export function offsiteAdapter(t: OffsiteTarget): StorageAdapter {
  return new S3Adapter(
    { endpoint: t.endpoint, region: t.region || 'us-east-1', accessKeyId: t.accessKey, secretAccessKey: t.secretKey },
    t.bucket,
  );
}

/** Object key inside the target, under its configured prefix. */
export function offsiteKey(t: Pick<OffsiteTarget, 'prefix'>, key: string): string {
  return t.prefix ? `${t.prefix}/${key}` : key;
}
