jest.mock('../../src/config/database', () => ({ getDb: jest.fn() }));
import { resolveDefaultBranch, repositoryHasBranch } from '../../src/lib/git-default-branch';
import { projectRevision } from '../../src/lib/project-revision';
import { getDb } from '../../src/config/database';

const http = jest.fn();
const originalFetch = global.fetch;
const update = jest.fn();
beforeEach(() => {
  http.mockReset(); update.mockReset(); global.fetch = http;
  (getDb as jest.Mock).mockResolvedValue({ getRepository: () => ({ update }) });
});
afterAll(() => { global.fetch = originalFetch; });
const response = (data: any) => ({ ok: true, json: async () => data });
it.each(['master', 'trunk'])('discovers GitHub default %s without listing all branches', async branch => {
  http.mockResolvedValueOnce(response({ default_branch: branch }));
  expect(await resolveDefaultBranch('https://github.com/org/repo.git')).toBe(branch);
  expect(http).toHaveBeenCalledTimes(1);
  expect(http.mock.calls[0][0]).toBe('https://api.github.com/repos/org/repo');
});
it('uses GitLab nested project API', async () => {
  http.mockResolvedValueOnce(response({ default_branch: 'trunk' }));
  expect(await resolveDefaultBranch('git@gitlab.com:org/group/repo.git')).toBe('trunk');
  expect(http.mock.calls[0][0]).toBe('https://gitlab.com/api/v4/projects/org%2Fgroup%2Frepo');
});
it('falls back to smart HTTP HEAD symref on provider error', async () => {
  http.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ ok: true, text: async () => '001e# service=git-upload-pack\n0000009fabc HEAD\0multi_ack symref=HEAD:refs/heads/release/trunk agent=git\n0000' });
  expect(await resolveDefaultBranch('https://github.com/org/repo')).toBe('release/trunk');
  expect(http.mock.calls[1][0]).toContain('.git/info/refs?service=git-upload-pack');
  expect(http.mock.calls.every((c: any) => c[1].redirect === 'error')).toBe(true);
});
it('falls back to HEAD when no symref exists or both requests fail', async () => {
  http.mockResolvedValue({ ok: false, status: 503 });
  expect(await resolveDefaultBranch('https://github.com/org/repo')).toBe('HEAD');
});
it('does not contact unconfigured hosts or credential-bearing URLs', async () => {
  for (const url of ['https://localhost/repo/test', 'https://user:pass@github.com/org/repo', 'https://github.com/org/repo?token=x']) {
    expect(await resolveDefaultBranch(url)).toBe('HEAD');
  }
  expect(http).not.toHaveBeenCalled();
});
it('only treats a provider 404 as confirmed branch absence', async () => {
  http.mockResolvedValueOnce({ ok: false, status: 403 }).mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce({ ok: true });
  expect(await repositoryHasBranch('https://github.com/org/repo', 'main')).toBeUndefined();
  expect(await repositoryHasBranch('https://github.com/org/repo', 'main')).toBe(false);
  expect(await repositoryHasBranch('https://github.com/org/repo', 'main')).toBe(true);
});
it('honors explicit revision then branch then project override without HTTP', async () => {
  const project: any = { id: 'p', gitRevision: 'stable', defaultBranch: 'master' };
  expect(await projectRevision(project, 'v2', 'feature')).toBe('v2');
  expect(await projectRevision(project, undefined, 'feature')).toBe('feature');
  expect(await projectRevision(project)).toBe('stable');
  delete project.gitRevision;
  expect(await projectRevision(project)).toBe('master');
  expect(http).not.toHaveBeenCalled();
});
it('persists and reuses default per project without caching an explicit deployment ref', async () => {
  const project: any = { id: 'p', repositoryUrl: 'https://github.com/org/repo' };
  http.mockResolvedValue(response({ default_branch: 'master' }));
  expect(await projectRevision(project)).toBe('master');
  expect(await projectRevision(project, undefined, 'feature')).toBe('feature');
  expect(await projectRevision(project)).toBe('master');
  expect(update).toHaveBeenCalledWith({ id: 'p', repositoryUrl: project.repositoryUrl }, { defaultBranch: 'master' });
  expect(http).toHaveBeenCalledTimes(1);
});
it('does not persist failure so discovery can recover', async () => {
  http.mockResolvedValue({ ok: false });
  expect(await projectRevision({ id: 'p', repositoryUrl: 'https://github.com/org/repo' } as any)).toBe('HEAD');
  expect(update).not.toHaveBeenCalled();
});
