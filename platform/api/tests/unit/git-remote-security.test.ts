// No database in this unit test: no stored GitHub App / GitLab app (#35), env tokens apply.
jest.mock('../../src/config/database', () => ({ getDb: jest.fn().mockRejectedValue(new Error('no database in unit tests')) }));
import { parseGitRemote, fetchRepoBranches, clearBranchCacheForTests } from '../../src/lib/git-remote';

describe('provider credential destinations', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env.GITLAB_URL = 'https://gitlab.example.com';
    clearBranchCacheForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GITLAB_URL;
    delete process.env.GITHUB_TOKEN;
    clearBranchCacheForTests();
  });
  it.each(['https://gitlab.attacker.example/team/repo', 'https://gitlab.example.com.attacker.test/team/repo', 'https://gitlab.example.com@attacker.test/team/repo', 'http://gitlab.example.com/team/repo', 'https://gitlab.example.com:444/team/repo'])('rejects %s before fetching', async (url) => {
    global.fetch = jest.fn() as any;
    expect(parseGitRemote(url)).toBeNull();
    await expect(fetchRepoBranches(url)).rejects.toThrow(/Unsupported/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('supports nested GitLab groups and SSH with exact origin matching', () => {
    expect(parseGitRemote('git@gitlab.example.com:group/sub/repo.git')).toEqual({ provider: 'gitlab', owner: 'group/sub', repo: 'repo', apiBase: 'https://gitlab.example.com/api/v4' });
  });
  it('refuses redirects on token-bearing calls', async () => {
    process.env.GITLAB_TOKEN = 'test-provider-token';
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ default_branch: 'main' }) }).mockResolvedValueOnce({ ok: true, json: async () => [] }) as any;
    await fetchRepoBranches('https://gitlab.example.com/team/repo');
    for (const [url, options] of (global.fetch as jest.Mock).mock.calls) {
      expect(new URL(url).origin).toBe('https://gitlab.example.com');
      expect(options.redirect).toBe('error');
      expect(options.headers['PRIVATE-TOKEN']).toBe('test-provider-token');
    }
    delete process.env.GITLAB_TOKEN;
  });
  it('sends GitHub credentials from GITHUB_TOKEN and caches branch lists (#155)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ default_branch: 'main' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: 'main', commit: { sha: 'abc123' }, protected: true }],
      }) as any;

    const first = await fetchRepoBranches('https://github.com/acme/web.git');
    expect(first.defaultBranch).toBe('main');
    expect(first.branches).toEqual([{ name: 'main', sha: 'abc123', protected: true }]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    for (const [, options] of (global.fetch as jest.Mock).mock.calls) {
      expect(options.headers.Authorization).toBe('Bearer ghp_test_token');
      expect(options.redirect).toBe('error');
    }

    const second = await fetchRepoBranches('https://github.com/acme/web.git');
    expect(second).toEqual(first);
    expect(global.fetch).toHaveBeenCalledTimes(2); // cache hit — no more provider calls
  });
  it('surfaces GitHub rate-limit responses clearly (#155)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: 'API rate limit exceeded' }),
    }) as any;
    await expect(fetchRepoBranches('https://github.com/acme/other')).rejects.toThrow(/rate limit/i);
  });
});
