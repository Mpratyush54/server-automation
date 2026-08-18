jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue({
    getRepository: () => ({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
      create: jest.fn().mockImplementation((d: any) => d),
    }),
  }),
}));

import { buildAuthorizeUrl, loginFailedRedirect } from '../../../src/lib/oauth-login';

describe('oauth-login', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GITLAB_CLIENT_ID;
    delete process.env.GITLAB_CLIENT_SECRET;
  });

  it('rejects GitHub authorize when OAuth is not configured', async () => {
    const result = await buildAuthorizeUrl('github', 'api.example.test', 'https');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/GitHub login is not configured/);
  });

  it('builds a GitHub authorize URL when env credentials exist', async () => {
    process.env.GITHUB_CLIENT_ID = 'client-id';
    process.env.GITHUB_CLIENT_SECRET = 'client-secret';
    const result = await buildAuthorizeUrl('github', 'api.example.test', 'https');
    expect(result.ok).toBe(true);
    expect(result.url).toContain('github.com/login/oauth/authorize');
    expect(result.url).toContain('client_id=client-id');
    expect(result.url).toContain(encodeURIComponent('https://api.example.test/api/auth/github/callback'));
  });

  it('builds a login-failed portal redirect', () => {
    const url = loginFailedRedirect('api.example.test', 'https', 'nope');
    expect(url).toBe('https://example.test/login?error=nope');
  });
});
