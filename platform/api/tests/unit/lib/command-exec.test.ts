import { splitArgv, executeValidatedCommand } from '../../../src/lib/command-exec';

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

    it('dry-runs allowlisted read commands', async () => {
      const result = await executeValidatedCommand('kubectl get pods', { dryRun: true });
      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.stdout).toContain('kubectl get pods');
    });
  });
});
