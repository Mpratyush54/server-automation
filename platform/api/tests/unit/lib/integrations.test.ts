import { applyIntegrationsToEnv, maskSecret, publicAuthProviders, resolveIntegrations } from '../../../src/lib/integrations';

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(),
}));

describe('integrations', () => {
  const { getDb } = require('../../../src/config/database');

  const row = {
    id: 'int-1',
    githubClientId: 'gh-id',
    githubClientSecret: 'gh-secret',
    githubToken: 'ghp_saved',
    githubOrg: 'acme',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabClientId: 'gl-id',
    gitlabClientSecret: 'gl-secret',
    gitlabToken: 'glpat_saved',
    gitlabGroup: 'platform',
    clickupToken: 'pk_saved',
    clickupListId: '123',
    infisicalUrl: 'https://infisical.local',
    infisicalToken: 'st_saved',
    githubLoginEnabled: true,
    gitlabLoginEnabled: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    getDb.mockResolvedValue({
      getRepository: () => ({
        find: jest.fn().mockResolvedValue([row]),
        save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
        create: jest.fn().mockImplementation((d: any) => d),
      }),
    });
  });

  it('masks secrets without exposing the value', () => {
    expect(maskSecret('')).toEqual({ set: false, hint: '' });
    expect(maskSecret('ghp_abcdefghij')).toEqual({ set: true, hint: 'ghp_…ghij' });
  });

  it('resolves DB values over env and reports login ready', async () => {
    process.env.GITHUB_TOKEN = 'env-should-lose';
    const cfg = await resolveIntegrations();
    expect(cfg.githubToken).toBe('ghp_saved');
    expect(cfg.githubLoginEnabled).toBe(true);
    expect(cfg.gitlabLoginEnabled).toBe(true);
    const pub = publicAuthProviders(cfg);
    expect(pub.github).toEqual({ enabled: true, configured: true });
    expect(pub.gitlab.configured).toBe(true);
    expect(pub.gitlab.url).toBe('https://gitlab.example.com');
  });

  it('applies tokens into process.env', async () => {
    const cfg = await resolveIntegrations();
    applyIntegrationsToEnv(cfg);
    expect(process.env.GITHUB_TOKEN).toBe('ghp_saved');
    expect(process.env.GITLAB_TOKEN).toBe('glpat_saved');
    expect(process.env.CLICKUP_API_TOKEN).toBe('pk_saved');
  });

  it('disables login when the row flag is off even if credentials exist', async () => {
    getDb.mockResolvedValue({
      getRepository: () => ({
        find: jest.fn().mockResolvedValue([{ ...row, githubLoginEnabled: false, gitlabLoginEnabled: false }]),
        save: jest.fn(),
        create: jest.fn(),
      }),
    });
    const cfg = await resolveIntegrations();
    expect(cfg.githubLoginEnabled).toBe(false);
    expect(cfg.gitlabLoginEnabled).toBe(false);
  });
});
