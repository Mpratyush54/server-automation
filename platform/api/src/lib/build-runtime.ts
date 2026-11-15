import axios from 'axios';
import * as k8s from '@kubernetes/client-node';
import { Build } from '../entities/Build';
import { loadKubeConfig } from './kube-config';
import {
  BUILD_NAMESPACE, DIGEST_CONTAINERS, buildJobName, cloneSecretName, digestFromTerminationMessage, positiveBuildInt, pushSecretName, renderBuildJob,
} from './build-spec';
import { CloneRevocation, mintCloneCredential, revokeCloneCredential } from './build-source';
import { RepositorySource } from './repository-binding';
import { REGISTRY_INTERNAL_HOST, buildPushToken, pushCnbAuth, pushDockerConfig, retentionToken } from './registry-token';
import { acquireLock } from './locks';

/** A build that must not be (re)started: superseded, timed out, or its Job is gone. Never retried. */
export class BuildStopped extends Error {}

export function buildClients() {
  const kc = new k8s.KubeConfig();
  loadKubeConfig(kc);
  return { core: kc.makeApiClient(k8s.CoreV1Api), batch: kc.makeApiClient(k8s.BatchV1Api) };
}
const body = (r: any) => r.body || r;
const isCode = (e: any, code: number) => (e.code || e.statusCode || e.response?.statusCode) === code;
const pause = () => new Promise(resolve => setTimeout(resolve, 3000));
const LOG_CONTAINERS = ['clone', 'buildkit', 'bp-analyze', 'bp-detect', 'bp-restore', 'bp-build', 'publish', 'export'];

export function scrubBuildLogs(logs: string, header = '', extraSecrets: string[] = []): string {
  const values = [header, header.split(' ').pop() || '', ...extraSecrets];
  if (header.startsWith('Authorization: Basic ')) values.push(Buffer.from(values[1], 'base64').toString().split(':').slice(1).join(':'));
  for (const value of values.filter(v => v && v.length >= 8)) logs = logs.split(value).join('[redacted]');
  return logs.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/(?:gh[psu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|gldt-[A-Za-z0-9_-]+)/g, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]').slice(-200_000);
}

async function readSecret(name: string): Promise<Record<string, string> | null> {
  try {
    const secret: any = body(await buildClients().core.readNamespacedSecret({ namespace: BUILD_NAMESPACE, name }));
    return Object.fromEntries(Object.entries(secret.data || {}).map(([k, v]) => [k, Buffer.from(String(v), 'base64').toString()]));
  } catch (e) { if (isCode(e, 404)) return null; throw e; }
}

async function upsertSecret(name: string, data: Record<string, string>): Promise<void> {
  const { core } = buildClients();
  const secret = { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name, namespace: BUILD_NAMESPACE }, stringData: data };
  try { await core.createNamespacedSecret({ namespace: BUILD_NAMESPACE, body: secret }); }
  catch (e) {
    if (!isCode(e, 409)) throw e;
    const previous: any = body(await core.readNamespacedSecret({ namespace: BUILD_NAMESPACE, name }));
    await core.replaceNamespacedSecret({ namespace: BUILD_NAMESPACE, name, body: { ...secret, metadata: { ...secret.metadata, resourceVersion: previous.metadata.resourceVersion } } });
  }
}

async function deleteSecret(name: string): Promise<void> {
  try { await buildClients().core.deleteNamespacedSecret({ namespace: BUILD_NAMESPACE, name }); }
  catch (e) { if (!isCode(e, 404)) throw e; }
}

/** Values to redact from logs: the clone header/token and the push token, if still known. */
async function knownSecrets(build: Build): Promise<{ header: string; values: string[] }> {
  const clone = await readSecret(cloneSecretName(build.id));
  const push = await readSecret(pushSecretName(build.id));
  return { header: clone?.header || '', values: [clone?.secret || '', push?.token || ''] };
}

/** Revoke the clone credential and delete its Secret. Idempotent; safe after an API restart. */
export async function releaseCloneCredential(build: Pick<Build, 'id'>): Promise<void> {
  const clone = await readSecret(cloneSecretName(build.id));
  if (clone?.revoke) {
    try { await revokeCloneCredential(JSON.parse(clone.revoke) as CloneRevocation); }
    catch { console.warn('[build] clone credential revocation failed; it expires on its own'); }
  }
  await deleteSecret(cloneSecretName(build.id));
}

export async function cleanupBuildSecret(build: Pick<Build, 'id'>): Promise<void> {
  await releaseCloneCredential(build);
  await deleteSecret(pushSecretName(build.id));
}

export async function readBuildLogs(build: Build, pods?: any[], secrets?: { header: string; values: string[] }): Promise<string> {
  const { core } = buildClients();
  pods ||= body(await core.listNamespacedPod({ namespace: BUILD_NAMESPACE, labelSelector: `job-name=${buildJobName(build.id)}` })).items;
  const logs: string[] = [];
  for (const pod of pods || []) {
    for (const container of LOG_CONTAINERS) {
      try {
        const result = await core.readNamespacedPodLog({ namespace: BUILD_NAMESPACE, name: pod.metadata.name, container, tailLines: 1000, limitBytes: 65000 });
        const text = String(body(result) || '');
        if (text) logs.push(`[${container}]\n${text}`);
      } catch (e) { if (!isCode(e, 400)) throw e; }
    }
  }
  const known = secrets || await knownSecrets(build);
  return scrubBuildLogs(logs.join('\n'), known.header, known.values);
}

export async function cancelBuildJob(build: Pick<Build, 'id'>): Promise<void> {
  try {
    await buildClients().batch.deleteNamespacedJob({ namespace: BUILD_NAMESPACE, name: buildJobName(build.id), propagationPolicy: 'Foreground' });
  } catch (e) { if (!isCode(e, 404)) throw e; }
}

const terminated = (pod: any, name: string, init: boolean) =>
  (init ? pod.status?.initContainerStatuses : pod.status?.containerStatuses)?.find((s: any) => s.name === name)?.state?.terminated;

/** Digest reported by a trusted publish/export step of this build; never from a tag lookup. */
export function digestFromPods(pods: any[], build: Pick<Build, 'projectId' | 'environmentId'>): string | null {
  for (const pod of pods) {
    for (const name of DIGEST_CONTAINERS) {
      const state = terminated(pod, name, false);
      if (state?.exitCode !== 0) continue;
      const digest = digestFromTerminationMessage(state.message, build);
      if (digest) return digest;
    }
  }
  return null;
}

export interface BuildJobHooks {
  saveLogs(logs: string): Promise<void>;
  /** Re-read before admission; false when the build was superseded or cancelled. */
  stillQueued(): Promise<boolean>;
  /** Persist that the Job exists, before any retry could create a second one. */
  markSubmitted(): Promise<void>;
}

export function buildLimits() {
  return {
    global: positiveBuildInt(process.env.BUILDS_MAX_CONCURRENT, 1, 8),
    perProject: positiveBuildInt(process.env.BUILDS_MAX_ACTIVE_PER_PROJECT, 1, 8),
    timeout: positiveBuildInt(process.env.BUILDS_TIMEOUT_SECONDS, 900, 3600),
  };
}

/**
 * Admit, create and follow one build Job; returns the digest the trusted step pushed.
 * Deterministic Job names let the operation worker reattach after API restarts. A build whose
 * Job was already submitted is never submitted again (timeouts and expiry are final).
 */
export async function runBuildJob(build: Build, source: RepositorySource, hooks: BuildJobHooks): Promise<string> {
  const { core, batch } = buildClients();
  const name = buildJobName(build.id);
  const limits = buildLimits();
  const deadline = Date.now() + positiveBuildInt(process.env.BUILDS_QUEUE_TIMEOUT_SECONDS, 3600, 86400) * 1000;
  let secrets: { header: string; values: string[] } | undefined;
  while (true) {
    try { await batch.readNamespacedJob({ namespace: BUILD_NAMESPACE, name }); break; }
    catch (e) { if (!isCode(e, 404)) throw e; }
    if (build.jobSubmittedAt) throw new BuildStopped('The build Job no longer exists (timed out, cancelled or expired); start a new build');
    if (Date.now() > deadline) throw new BuildStopped('Build queue timed out');
    if (!await hooks.stillQueued()) throw new BuildStopped('Build superseded by a newer push');
    const lock = await acquireLock('lock:builds:admission', { holder: build.id });
    if (!lock) { await pause(); continue; }
    let revoke: CloneRevocation | null = null;
    let submitted = false;
    try {
      const jobs = body(await batch.listNamespacedJob({ namespace: BUILD_NAMESPACE })).items;
      const active = jobs.filter((j: any) => !j.status?.succeeded && !j.status?.failed);
      if (active.length >= limits.global) continue;
      if (active.filter((j: any) => j.metadata?.labels?.['cairn.dev/project'] === build.projectId).length >= limits.perProject) continue;
      const clone = await mintCloneCredential(source, build.id);
      revoke = clone.revoke;
      const pushToken = await buildPushToken(build.projectId, build.environmentId, build.id, limits.timeout + 600);
      secrets = { header: clone.header, values: [clone.secret, pushToken] };
      await upsertSecret(cloneSecretName(build.id), { header: clone.header, secret: clone.secret, revoke: JSON.stringify(clone.revoke) });
      await upsertSecret(pushSecretName(build.id), { 'config.json': pushDockerConfig(pushToken), 'cnb-auth': pushCnbAuth(pushToken), token: pushToken });
      const job: any = body(await batch.createNamespacedJob({ namespace: BUILD_NAMESPACE, body: renderBuildJob(build, clone.url) }));
      submitted = true;
      build.jobSubmittedAt = new Date();
      await hooks.markSubmitted();
      const owner = { metadata: { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name, uid: job.metadata.uid }] } };
      for (const secret of [cloneSecretName(build.id), pushSecretName(build.id)]) await core.patchNamespacedSecret({ namespace: BUILD_NAMESPACE, name: secret, body: owner }, k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch));
      break;
    } catch (error) {
      if (!submitted && revoke) {
        await revokeCloneCredential(revoke).catch(() => undefined);
        await deleteSecret(cloneSecretName(build.id)).catch(() => undefined);
        await deleteSecret(pushSecretName(build.id)).catch(() => undefined);
      }
      throw error;
    } finally { await lock.release(); await pause(); }
  }
  secrets ||= await knownSecrets(build);
  let cloneReleased = false;
  while (true) {
    const job: any = body(await batch.readNamespacedJob({ namespace: BUILD_NAMESPACE, name }));
    const pods = body(await core.listNamespacedPod({ namespace: BUILD_NAMESPACE, labelSelector: `job-name=${name}` })).items || [];
    await hooks.saveLogs(await readBuildLogs(build, pods, secrets));
    // The Git credential is only needed by the clone step: revoke it as soon as that step ends.
    if (!cloneReleased && pods.some((pod: any) => terminated(pod, 'clone', true))) { await releaseCloneCredential(build); cloneReleased = true; }
    if (job.status?.succeeded) {
      const digest = digestFromPods(pods, build);
      if (!digest) throw new BuildStopped('The publish step reported no image digest');
      return digest;
    }
    if (job.status?.failed || job.status?.conditions?.some((c: any) => c.type === 'Failed' && c.status === 'True')) throw new BuildStopped('Build Job failed; see build logs');
    if (job.metadata?.creationTimestamp && Date.now() - new Date(job.metadata.creationTimestamp).getTime() > (limits.timeout + 60) * 1000) {
      await batch.deleteNamespacedJob({ namespace: BUILD_NAMESPACE, name, propagationPolicy: 'Foreground' });
      throw new BuildStopped('Build Job timed out');
    }
    await pause();
  }
}

/** The registry has no manifest for the reference (HEAD answered 404). */
export class RegistryNotFoundError extends Error {}

/** Manifest HEAD/DELETE as the API's retention identity, over the in-cluster registry Service. */
export async function registryManifest(image: string, method: 'HEAD' | 'DELETE' = 'HEAD'): Promise<string> {
  const registry = process.env.BUILDS_REGISTRY || '';
  if (!registry || !image.startsWith(`${registry}/`)) throw new Error('Invalid build registry image');
  const ref = image.slice(registry.length + 1);
  const separator = ref.includes('@') ? '@' : ':';
  const index = ref.lastIndexOf(separator);
  if (index < 1) throw new Error('Image reference required');
  const repository = ref.slice(0, index);
  const response = await axios.request({ url: `http://${REGISTRY_INTERNAL_HOST}/v2/${repository}/manifests/${ref.slice(index + 1)}`,
    method, maxRedirects: 0, timeout: 30_000, validateStatus: () => true,
    headers: { Authorization: `Bearer ${await retentionToken(repository)}`, Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' },
  });
  if (method === 'DELETE' && response.status === 404) return '';
  if (method === 'HEAD' && response.status === 404) throw new RegistryNotFoundError('Registry has no such manifest');
  if (response.status < 200 || response.status >= 300) throw new Error(`Registry ${method} failed (${response.status})`);
  const digest = String(response.headers['docker-content-digest'] || '');
  if (method === 'HEAD' && !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Registry returned no image digest');
  return digest;
}

/**
 * TODO(source-build-signing): sign `imageDigest` — the digest reported by the trusted push step,
 * never a tag — once a cluster signing identity exists; release CI uses GitHub OIDC, unavailable to Jobs.
 */
export async function signBuiltImage(_imageDigest: string): Promise<void> {
  if (process.env.BUILDS_REQUIRE_SIGNATURE === 'true') throw new Error('Source build signing identity is not configured');
}
