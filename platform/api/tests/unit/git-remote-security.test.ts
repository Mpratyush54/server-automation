import { parseGitRemote, fetchRepoBranches } from '../../src/lib/git-remote';

describe('provider credential destinations', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { process.env.GITLAB_URL = 'https://gitlab.example.com'; });
  afterEach(() => { global.fetch = originalFetch; delete process.env.GITLAB_URL; });
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
});
