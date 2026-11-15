import { Build } from '../../../src/entities/Build';
import {
  BUILDKIT_APPARMOR_PROFILE, BUILDKIT_SECCOMP_PROFILE, BUILD_RUNTIME_LABEL, TRUSTED_PUSH_CONTAINERS, UNTRUSTED_CONTAINERS,
  digestFromTerminationMessage, positiveBuildInt, renderBuildJob, retentionCandidates, validateBuildRef,
} from '../../../src/lib/build-spec';
import { sourceWorkload } from '../../../src/lib/source-deploy';

jest.mock('@kubernetes/client-node', () => ({}));
const build = { id: 'b', projectId: 'p1', commitSha: 'a'.repeat(40), imageTag: 'registry.example.com/p-p1/e-e1:' + 'a'.repeat(40), environmentId: 'e1' };
const internal = 'registry.registry.svc.cluster.local:5000/p-p1/e-e1';
const render = () => renderBuildJob(build, 'https://github.com/acme/app.git');
const all = (): any[] => { const pod: any = render().spec.template.spec; return [...pod.initContainers, ...pod.containers]; };
const byName = (name: string) => all().find(c => c.name === name);

describe('source build Job', () => {
  it('runs the steps in a fixed order: clone, untrusted build steps, then trusted push steps', () => {
    const pod: any = render().spec.template.spec;
    expect(pod.initContainers.map((c: any) => c.name)).toEqual(['clone', 'buildkit', 'bp-analyze', 'bp-detect', 'bp-restore', 'bp-build']);
    expect(pod.containers.map((c: any) => c.name)).toEqual(['publish', 'export']);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.enableServiceLinks).toBe(false);
    expect(render().spec.backoffLimit).toBe(0);
    expect(render().spec.activeDeadlineSeconds).toBe(900);
    expect(render().metadata.labels['cairn.dev/project']).toBe('p1');
  });

  it('gives repository-controlled containers no Git token, no registry credential and no secrets of any kind', () => {
    for (const name of UNTRUSTED_CONTAINERS) {
      const container = byName(name);
      const text = JSON.stringify(container);
      expect(container.volumeMounts.some((v: any) => ['git-auth', 'push-auth'].includes(v.name))).toBe(false);
      expect(text).not.toMatch(/secretKeyRef|DOCKER_CONFIG|CNB_REGISTRY_AUTH|registrytoken|Authorization/);
      expect(container.volumeMounts.find((v: any) => v.name === 'meta').readOnly).toBe(true);
    }
    // The Git credential is mounted only into the clone step.
    expect(all().filter(c => c.volumeMounts.some((v: any) => v.name === 'git-auth')).map(c => c.name)).toEqual(['clone']);
    // The push credential reaches only platform-controlled steps.
    const withPush = all().filter(c => /push-auth|secretKeyRef/.test(JSON.stringify(c))).map(c => c.name);
    expect(withPush.sort()).toEqual([...TRUSTED_PUSH_CONTAINERS].sort());
    expect(JSON.stringify(render())).not.toMatch(/x-access-token|Authorization:|build-registry-auth/);
  });

  it('builds Dockerfiles to a local archive and pushes it from a separate trusted step that reports the digest', () => {
    const buildkit = byName('buildkit');
    expect(buildkit.image).toMatch(/buildkit:.*rootless/);
    expect(buildkit.command[2]).toContain('type=docker,name=$IMAGE,dest=/out/image.tar');
    expect(buildkit.command[2]).not.toMatch(/push=true|type=registry|export-cache|import-cache/);
    expect(buildkit.env).toContainEqual({ name: 'IMAGE', value: `${internal}:${build.commitSha}` });
    const publish = byName('publish');
    expect(publish.command[2]).toContain('[ -L /out/image.tar ]');
    expect(publish.command[2]).toContain('--image-refs=/dev/termination-log');
    expect(publish.volumeMounts.find((v: any) => v.name === 'out').readOnly).toBe(true);
    expect(publish.env).toContainEqual({ name: 'DOCKER_CONFIG', value: '/push-auth' });
  });

  it('splits the Buildpacks lifecycle so buildpack code never shares a container with registry credentials', () => {
    expect(byName('bp-detect').command[2]).toContain('/cnb/lifecycle/detector');
    expect(byName('bp-build').command[2]).toContain('/cnb/lifecycle/builder');
    expect(byName('bp-analyze').command[2]).toContain('/cnb/lifecycle/analyzer');
    expect(byName('bp-restore').command[2]).toContain('/cnb/lifecycle/restorer');
    const exporter = byName('export');
    expect(exporter.command[2]).toContain('/cnb/lifecycle/exporter');
    expect(exporter.command[2]).toContain('-report=/tmp/report.toml');
    expect(exporter.command[2]).toContain('> /dev/termination-log');
    expect(exporter.env).toContainEqual({ name: 'CNB_REGISTRY_AUTH', valueFrom: { secretKeyRef: { name: 'build-b-push', key: 'cnb-auth' } } });
    expect(JSON.stringify(all())).not.toContain('/cnb/lifecycle/creator');
  });

  it('chooses the builder from a marker written by the trusted clone step', () => {
    expect(byName('clone').command[2]).toContain('echo dockerfile > /meta/kind');
    // The workspace emptyDir is owned by root (fsGroup), not the clone user; Git refuses it unless marked safe.
    expect(byName('clone').command[2]).toContain('GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1=/workspace');
    expect(byName('clone').volumeMounts.find((v: any) => v.name === 'meta').readOnly).toBe(false);
    expect(byName('buildkit').command[2]).toContain('= dockerfile ] || exit 0');
    expect(byName('publish').command[2]).toContain('= dockerfile ] || exit 0');
    for (const name of ['bp-analyze', 'bp-detect', 'bp-restore', 'bp-build', 'export']) expect(byName(name).command[2]).toContain('= buildpacks ] || exit 0');
  });

  it('relaxes the runtime only for the BuildKit container, with node-local profiles and no privileged settings', () => {
    const pod: any = render().spec.template.spec;
    expect(pod.securityContext.seccompProfile).toEqual({ type: 'RuntimeDefault' });
    expect(pod.nodeSelector).toEqual({ [BUILD_RUNTIME_LABEL]: 'v1' });
    // Only the setuid ID-mapping helpers' capabilities remain; see buildkitSecurityContext.
    expect(byName('buildkit').securityContext).toEqual({ allowPrivilegeEscalation: true, capabilities: { drop: ['ALL'], add: ['SETUID', 'SETGID'] },
      seccompProfile: { type: 'Localhost', localhostProfile: BUILDKIT_SECCOMP_PROFILE },
      appArmorProfile: { type: 'Localhost', localhostProfile: BUILDKIT_APPARMOR_PROFILE } });
    for (const c of all().filter(c => c.name !== 'buildkit')) {
      const { runAsUser, runAsGroup, ...rest } = c.securityContext;
      expect(rest).toEqual({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
      // The lifecycle runs as the builder's CNB user so it never needs CAP_SETUID to switch users.
      if (c.name.startsWith('bp-') || c.name === 'export' || c.name === 'clone') expect([runAsUser, runAsGroup]).toEqual([1001, 1000]);
      else expect(runAsUser).toBeUndefined();
    }
    expect(JSON.stringify(render())).not.toMatch(/privileged|hostPath|Unconfined|hostNetwork|hostPID/);
  });

  it('bounds CPU, memory and ephemeral storage for every container and volume', () => {
    for (const c of all()) {
      expect(c.resources.limits['ephemeral-storage']).toBeDefined();
      expect(c.resources.requests['ephemeral-storage']).toBeDefined();
      expect(c.resources.limits.memory).toBeDefined();
    }
    const pod: any = render().spec.template.spec;
    for (const v of pod.volumes.filter((v: any) => v.emptyDir)) expect(v.emptyDir.sizeLimit).toBeDefined();
  });

  it.each(['-branch', '../main', 'main;echo', 'main\n', 'main/'])('rejects invalid branch %p', branch => {
    expect(() => validateBuildRef(branch, build.commitSha)).toThrow();
  });

  it('rejects unpinned commits and bounds timeouts/concurrency', () => {
    expect(() => validateBuildRef('main', 'HEAD')).toThrow();
    expect(() => validateBuildRef('feature/api', build.commitSha)).not.toThrow();
    expect(positiveBuildInt('0', 1, 8)).toBe(1);
    expect(positiveBuildInt('9', 1, 8)).toBe(1);
    expect(positiveBuildInt('2', 1, 8)).toBe(2);
  });
});

describe('pushed digest', () => {
  const digest = `sha256:${'b'.repeat(64)}`;
  it('accepts only a digest for this build\'s own repository', () => {
    expect(digestFromTerminationMessage(`${internal}@${digest}\n`, build)).toBe(digest);
    expect(digestFromTerminationMessage(`registry.registry.svc.cluster.local:5000/p-other/e-e1@${digest}`, build)).toBeNull();
    expect(digestFromTerminationMessage(`${internal}@sha256:short`, build)).toBeNull();
    expect(digestFromTerminationMessage(`${internal}:latest`, build)).toBeNull();
    expect(digestFromTerminationMessage(undefined, build)).toBeNull();
  });
});

it('retains recent, live, shared-digest and nonterminal images', () => {
  const row = (id: string, age: number, digest: string, status = 'succeeded') => ({ id, status, imageDigest: digest, imageTag: `registry/p:${id}`, createdAt: new Date(age), prunedAt: null } as Build);
  const builds = [row('old', 1, 'sha256:old'), row('shared', 2, 'sha256:current'), row('live', 3, 'sha256:live'), row('failed', 4, 'sha256:failed', 'failed'), row('current', 5, 'sha256:current')];
  expect(retentionCandidates(builds, 1, ['registry/p@sha256:live']).map(b => b.id)).toEqual(['old']);
});

it('renders a restricted source workload that re-authorizes every pull', () => {
  const dep = sourceWorkload('project-ns', 'source-p', 'registry/p@sha256:abc', 'p', 'staging');
  expect(dep.spec.template.spec.imagePullSecrets).toEqual([{ name: 'source-registry' }]);
  expect(dep.spec.template.spec.containers[0].image).toBe('registry/p@sha256:abc');
  expect(dep.spec.template.spec.containers[0].imagePullPolicy).toBe('Always');
  expect(dep.spec.template.spec.containers[0].readinessProbe.tcpSocket.port).toBe(8080);
  expect(dep.spec.template.spec.securityContext.runAsNonRoot).toBe(true);
});
