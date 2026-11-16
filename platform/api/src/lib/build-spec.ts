import { Build } from '../entities/Build';
import { REGISTRY_INTERNAL_HOST, buildRepository } from './registry-token';

export const BUILD_NAMESPACE = 'builds';
export const BUILD_IMAGES = {
  git: 'alpine/git:2.47.2',
  buildkit: 'moby/buildkit:v0.20.2-rootless',
  buildpacks: 'paketobuildpacks/builder-jammy-base:0.4.674',
  runImage: 'paketobuildpacks/run-jammy-base:0.1.285',
  // Debug variant: the publish step needs a shell for its archive checks.
  publish: 'gcr.io/go-containerregistry/crane/debug:v0.21.5',
};
/** Nodes where platformctl installed the BuildKit runtime profiles carry this label. */
export const BUILD_RUNTIME_LABEL = 'cairn.dev/build-runtime';
export const BUILD_RUNTIME_VERSION = 'v2';
/** Node-local profiles, relative to the kubelet seccomp root and the loaded AppArmor profiles. */
export const BUILDKIT_SECCOMP_PROFILE = 'cairn/buildkit-v2.json';
export const BUILDKIT_APPARMOR_PROFILE = 'cairn-buildkit-v1';

/** Containers that execute repository-controlled code. They never receive credentials. */
export const UNTRUSTED_CONTAINERS = ['buildkit', 'bp-detect', 'bp-build'];
/** Platform-controlled containers; only these may use the push credential. */
export const TRUSTED_PUSH_CONTAINERS = ['bp-analyze', 'bp-restore', 'publish', 'export'];
/** Trusted containers whose termination message carries the pushed image reference. */
export const DIGEST_CONTAINERS = ['publish', 'export'];

export function positiveBuildInt(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback;
}

export function validateBuildRef(branch: unknown, commit: unknown): void {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)
    || branch.includes('..') || branch.endsWith('/') || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('A branch and a full commit SHA are required');
  }
}

export function buildJobName(id: string): string { return `build-${id}`; }
export function cloneSecretName(id: string): string { return `build-${id}-git`; }
export function pushSecretName(id: string): string { return `build-${id}-push`; }

/** Where the trusted steps push (in-cluster); the digest is identical under the public name. */
export function internalImageRepository(build: Pick<Build, 'projectId' | 'environmentId'>): string {
  return `${REGISTRY_INTERNAL_HOST}/${buildRepository(build.projectId, build.environmentId)}`;
}

const kindIs = (kind: 'dockerfile' | 'buildpacks') => `[ "$(cat /meta/kind)" = ${kind} ] || exit 0`;
const heavy = { requests: { cpu: '250m', memory: '512Mi', 'ephemeral-storage': '1Gi' }, limits: { cpu: '2', memory: '3Gi', 'ephemeral-storage': '12Gi' } };
const light = { requests: { cpu: '100m', memory: '128Mi', 'ephemeral-storage': '256Mi' }, limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '2Gi' } };
const locked = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } };
/**
 * The Buildpacks lifecycle switches to the builder's CNB user (1001:1000 in BUILD_IMAGES.buildpacks)
 * unless it already runs as that user, which needs CAP_SETUID. Its phases therefore run as that
 * user, and so does the clone step, so that buildpacks can write to the cloned workspace.
 */
const CNB_USER = { runAsUser: 1001, runAsGroup: 1000 };
const lockedCnb = { ...locked, ...CNB_USER };
/**
 * Rootless BuildKit maps its subordinate user range with the newuidmap/newgidmap helpers (file capabilities cap_setuid/cap_setgid),
 * which need privilege escalation and CAP_SETUID/CAP_SETGID in the bounding set; every other
 * capability is dropped. Inside the user namespace it creates, BuildKit holds only capabilities
 * scoped to that namespace.
 */
export const buildkitSecurityContext = {
  allowPrivilegeEscalation: true,
  capabilities: { drop: ['ALL'], add: ['SETUID', 'SETGID'] },
  seccompProfile: { type: 'Localhost', localhostProfile: BUILDKIT_SECCOMP_PROFILE },
  appArmorProfile: { type: 'Localhost', localhostProfile: BUILDKIT_APPARMOR_PROFILE },
};
const ca = { name: 'ca', mountPath: '/etc/ssl/certs/ca-certificates.crt', subPath: 'ca.crt', readOnly: true };
const meta = (readOnly: boolean) => ({ name: 'meta', mountPath: '/meta', readOnly });

/**
 * One Job per build, in strict sequence (init containers run one at a time, in order):
 *   clone (trusted, Git credential) -> buildkit | bp-analyze, bp-detect, bp-restore, bp-build
 *   -> publish | export (trusted, push credential)
 * Repository-controlled code runs only in UNTRUSTED_CONTAINERS, which have no Git token, no
 * registry credential and no service account token; BuildKit writes an image archive to an
 * emptyDir instead of pushing. The trusted publish/export step pushes with a token limited to
 * this environment's repository and reports the pushed digest through its own termination
 * message, which no other container can write.
 */
export function renderBuildJob(build: Pick<Build, 'id' | 'projectId' | 'commitSha' | 'imageTag' | 'environmentId'>, repositoryUrl: string) {
  const name = buildJobName(build.id);
  const repository = internalImageRepository(build);
  const image = `${repository}:${build.commitSha}`;
  const cache = `${repository}:cache`;
  const labels = { 'cairn.dev/build': build.id, 'cairn.dev/project': build.projectId };
  const lifecycleEnv = [{ name: 'CNB_PLATFORM_API', value: '0.12' }, { name: 'CNB_LAYERS_DIR', value: '/layers' }, { name: 'CNB_APP_DIR', value: '/workspace' }];
  const trustedLifecycleEnv = [...lifecycleEnv, { name: 'CNB_INSECURE_REGISTRIES', value: REGISTRY_INTERNAL_HOST },
    { name: 'CNB_REGISTRY_AUTH', valueFrom: { secretKeyRef: { name: pushSecretName(build.id), key: 'cnb-auth' } } },
    { name: 'IMAGE', value: image }, { name: 'CACHE', value: cache }];
  return {
    apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: BUILD_NAMESPACE, labels },
    spec: {
      backoffLimit: 0, activeDeadlineSeconds: positiveBuildInt(process.env.BUILDS_TIMEOUT_SECONDS, 900, 3600), ttlSecondsAfterFinished: 86400,
      template: { metadata: { labels }, spec: {
        restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
        nodeSelector: { [BUILD_RUNTIME_LABEL]: BUILD_RUNTIME_VERSION },
        securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
        volumes: [
          { name: 'ca', configMap: { name: 'build-ca' } },
          { name: 'meta', emptyDir: { sizeLimit: '1Mi' } },
          { name: 'source', emptyDir: { sizeLimit: '2Gi' } },
          { name: 'out', emptyDir: { sizeLimit: '4Gi' } },
          { name: 'buildkit-state', emptyDir: { sizeLimit: '6Gi' } },
          { name: 'layers', emptyDir: { sizeLimit: '6Gi' } },
          { name: 'git-auth', secret: { secretName: cloneSecretName(build.id), defaultMode: 288, items: [{ key: 'header', path: 'header' }] } },
          { name: 'push-auth', secret: { secretName: pushSecretName(build.id), defaultMode: 288, items: [{ key: 'config.json', path: 'config.json' }] } },
        ],
        initContainers: [
          { name: 'clone', image: BUILD_IMAGES.git,
            command: ['/bin/sh', '-ec', `export GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1=/workspace GIT_CONFIG_KEY_2=init.defaultBranch GIT_CONFIG_VALUE_2=build
export GIT_CONFIG_VALUE_0="$(cat /git-auth/header)"
git init -q /workspace
git -C /workspace remote add origin "$REPOSITORY"
git -C /workspace -c http.followRedirects=false fetch --depth=1 origin "$COMMIT"
git -C /workspace checkout --detach FETCH_HEAD
test "$(git -C /workspace rev-parse HEAD)" = "$COMMIT"
rm -rf /workspace/.git
if [ -f /workspace/Dockerfile ]; then echo dockerfile > /meta/kind; else echo buildpacks > /meta/kind; fi`],
            env: [{ name: 'REPOSITORY', value: repositoryUrl }, { name: 'COMMIT', value: build.commitSha }, { name: 'HOME', value: '/tmp' }, { name: 'GIT_TERMINAL_PROMPT', value: '0' }],
            volumeMounts: [{ name: 'source', mountPath: '/workspace' }, meta(false), { name: 'git-auth', mountPath: '/git-auth', readOnly: true }, ca],
            securityContext: lockedCnb, resources: light },
          // UNTRUSTED: Dockerfile RUN steps. Node-local seccomp/AppArmor profiles allow the
          // user-namespace and mount operations rootless BuildKit needs, for this container only.
          { name: 'buildkit', image: BUILD_IMAGES.buildkit, workingDir: '/workspace',
            command: ['/bin/sh', '-ec', `${kindIs('dockerfile')}
exec buildctl-daemonless.sh build --frontend dockerfile.v0 --local context=/workspace --local dockerfile=/workspace --output "type=docker,name=$IMAGE,dest=/out/image.tar"`],
            env: [{ name: 'IMAGE', value: image }, { name: 'BUILDKITD_FLAGS', value: '--oci-worker-no-process-sandbox --oci-worker-snapshotter=native' }],
            volumeMounts: [{ name: 'source', mountPath: '/workspace' }, meta(true), { name: 'out', mountPath: '/out' }, { name: 'buildkit-state', mountPath: '/home/user/.local/share/buildkit' }, ca],
            securityContext: buildkitSecurityContext,
            resources: heavy },
          // Buildpacks: the lifecycle is split so buildpack code (detect, build) never runs in a
          // container that holds registry credentials (the model pack uses for untrusted builders).
          { name: 'bp-analyze', image: BUILD_IMAGES.buildpacks,
            command: ['/bin/bash', '-ec', `${kindIs('buildpacks')}
exec /cnb/lifecycle/analyzer -layers=/layers -run-image="$RUN_IMAGE" "$IMAGE"`],
            env: [...trustedLifecycleEnv, { name: 'RUN_IMAGE', value: BUILD_IMAGES.runImage }],
            volumeMounts: [meta(true), { name: 'layers', mountPath: '/layers' }], securityContext: lockedCnb, resources: light },
          { name: 'bp-detect', image: BUILD_IMAGES.buildpacks,
            command: ['/bin/bash', '-ec', `${kindIs('buildpacks')}
exec /cnb/lifecycle/detector -app=/workspace -layers=/layers`],
            env: lifecycleEnv,
            volumeMounts: [{ name: 'source', mountPath: '/workspace' }, meta(true), { name: 'layers', mountPath: '/layers' }, ca], securityContext: lockedCnb, resources: heavy },
          { name: 'bp-restore', image: BUILD_IMAGES.buildpacks,
            command: ['/bin/bash', '-ec', `${kindIs('buildpacks')}
exec /cnb/lifecycle/restorer -layers=/layers -cache-image="$CACHE"`],
            env: trustedLifecycleEnv,
            volumeMounts: [meta(true), { name: 'layers', mountPath: '/layers' }], securityContext: lockedCnb, resources: light },
          { name: 'bp-build', image: BUILD_IMAGES.buildpacks,
            command: ['/bin/bash', '-ec', `${kindIs('buildpacks')}
exec /cnb/lifecycle/builder -app=/workspace -layers=/layers`],
            env: lifecycleEnv,
            volumeMounts: [{ name: 'source', mountPath: '/workspace' }, meta(true), { name: 'layers', mountPath: '/layers' }, ca], securityContext: lockedCnb, resources: heavy },
        ],
        containers: [
          // TRUSTED: pushes the archive BuildKit produced; crane reports the digest it pushed.
          { name: 'publish', image: BUILD_IMAGES.publish,
            command: ['/busybox/sh', '-ec', `${kindIs('dockerfile')}
if [ -L /out/image.tar ] || [ ! -f /out/image.tar ]; then echo 'The build produced no image archive' >&2; exit 1; fi
exec /ko-app/crane push --insecure --image-refs=/dev/termination-log /out/image.tar "$IMAGE"`],
            env: [{ name: 'IMAGE', value: image }, { name: 'DOCKER_CONFIG', value: '/push-auth' }],
            volumeMounts: [meta(true), { name: 'out', mountPath: '/out', readOnly: true }, { name: 'push-auth', mountPath: '/push-auth', readOnly: true }],
            securityContext: locked, resources: light },
          // TRUSTED: the lifecycle exporter writes its report to container-local /tmp.
          { name: 'export', image: BUILD_IMAGES.buildpacks,
            command: ['/bin/bash', '-ec', `${kindIs('buildpacks')}
/cnb/lifecycle/exporter -app=/workspace -layers=/layers -cache-image="$CACHE" -report=/tmp/report.toml "$IMAGE"
digest="$(sed -n 's/^[[:space:]]*digest = "\\(sha256:[a-f0-9]\\{64\\}\\)".*/\\1/p' /tmp/report.toml | head -n 1)"
test -n "$digest"
printf '%s@%s' "$REPOSITORY" "$digest" > /dev/termination-log`],
            env: [...trustedLifecycleEnv, { name: 'REPOSITORY', value: repository }],
            volumeMounts: [{ name: 'source', mountPath: '/workspace', readOnly: true }, meta(true), { name: 'layers', mountPath: '/layers' }],
            securityContext: lockedCnb, resources: light },
        ],
      } },
    },
  };
}

/** The digest a trusted step reported for exactly this build's repository, or null. */
export function digestFromTerminationMessage(message: string | undefined, build: Pick<Build, 'projectId' | 'environmentId'>): string | null {
  const value = String(message || '').trim();
  const prefix = `${internalImageRepository(build)}@`;
  if (!value.startsWith(prefix)) return null;
  const digest = value.slice(prefix.length);
  return /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : null;
}

/** Never delete a digest still referenced by a retained build, cache or deployment. */
export function retentionCandidates(builds: Build[], keep: number, protectedImages: string[]): Build[] {
  const successes = builds.filter(b => b.status === 'succeeded' && !b.prunedAt).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const retained = successes.slice(0, Math.max(1, keep));
  const protectedDigests = new Set(retained.map(b => b.imageDigest));
  return successes.slice(Math.max(1, keep)).filter(b => b.imageDigest && !protectedDigests.has(b.imageDigest)
    && !protectedImages.some(image => image === b.imageTag || image.endsWith(`@${b.imageDigest}`)));
}
