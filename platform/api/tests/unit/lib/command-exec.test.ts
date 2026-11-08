import { splitArgv, executeValidatedCommand, buildChildEnv } from '../../../src/lib/command-exec';

describe('command-exec', () => {
  describe('splitArgv', () => {
    it('splits plain args', () => {
      expect(splitArgv('kubectl get pods')).toEqual(['kubectl', 'get', 'pods']);
    });

    it('keeps quoted segments', () => {
      expect(splitArgv('kubectl get pods -l "app=api"')).toEqual([
        'kubectl',
        'get',
        'pods',
        '-l',
        'app=api',
      ]);
    });
  });

  describe('executeValidatedCommand', () => {
    it('refuses denied commands', async () => {
      const result = await executeValidatedCommand('rm -rf /', { dryRun: true });
      expect(result.ok).toBe(false);
      expect(result.validation.allowed).toBe(false);
    });

    it('refuses env-based exec bypass', async () => {
      const result = await executeValidatedCommand('env sh -c id', { dryRun: true });
      expect(result.ok).toBe(false);
      expect(result.validation.allowed).toBe(false);
    });

    it('dry-runs allowlisted read commands', async () => {
      const result = await executeValidatedCommand('kubectl get pods', { dryRun: true });
      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.stdout).toContain('kubectl get pods');
    });
  });

  describe('buildChildEnv', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    it('passes only PATH/HOME/KUBECONFIG (+ in-cluster service vars), never API secrets', () => {
      process.env.JWT_SECRET = 'super-secret-jwt';
      process.env.POSTGRES_PASSWORD = 'pg-pass';
      process.env.KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';
      process.env.HOME = '/root';
      const env = buildChildEnv({ AWS_SECRET_ACCESS_KEY: 'nope' } as any);
      expect(env.JWT_SECRET).toBeUndefined();
      expect(env.POSTGRES_PASSWORD).toBeUndefined();
      expect((env as any).AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.KUBECONFIG).toBe('/etc/rancher/k3s/k3s.yaml');
      expect(env.HOME).toBe('/root');
      expect(env.PATH).toBeTruthy();
      expect(Object.keys(env).every((k) => ['PATH', 'HOME', 'KUBECONFIG', 'KUBERNETES_SERVICE_HOST', 'KUBERNETES_SERVICE_PORT'].includes(k))).toBe(true);
    });
  });
});
