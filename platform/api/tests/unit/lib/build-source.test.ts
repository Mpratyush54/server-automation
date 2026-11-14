const mockMint = jest.fn(async (..._a: any[]) => ({ token: 'ghs_scoped_token', expiresAt: Date.now() + 3600_000 }));
const mockRevoke = jest.fn(async (..._a: any[]) => undefined);
const mockGitlabToken = jest.fn(async () => 'glpat-instance-token');
jest.mock('../../../src/lib/github-app', () => ({ mintScopedInstallationToken: (...a: any[]) => mockMint(...a), revokeInstallationToken: (...a: any[]) => mockRevoke(...a) }));
jest.mock('../../../src/lib/gitlab-app', () => ({ gitlabApiToken: () => mockGitlabToken() }));
import { mintCloneCredential, revokeCloneCredential, verifyCommitOnBranch } from '../../../src/lib/build-source';

const sha = 'a'.repeat(40);
const head = 'b'.repeat(40);
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const originalFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => { jest.clearAllMocks(); fetchMock = jest.fn(); global.fetch = fetchMock as any; delete process.env.GITLAB_URL; });
afterAll(() => { global.fetch = originalFetch; });

describe('clone credentials', () => {
  it('uses a dedicated repository-scoped GitHub App token and nothing broader', async () => {
    process.env.GITHUB_TOKEN = 'legacy-pat';
    const cred = await mintCloneCredential('https://github.com/acme/app.git', 'b1');
    expect(mockMint).toHaveBeenCalledWith('acme', 'app');
    expect(cred.url).toBe('https://github.com/acme/app.git');
    expect(cred.header).toBe(`Authorization: Basic ${Buffer.from('x-access-token:ghs_scoped_token').toString('base64')}`);
    expect(JSON.stringify(cred)).not.toContain('legacy-pat');
    expect(cred.revoke).toEqual({ provider: 'github', token: 'ghs_scoped_token' });
    delete process.env.GITHUB_TOKEN;
  });

  it('refuses GitHub builds when the App is not installed instead of falling back', async () => {
    mockMint.mockRejectedValueOnce(new Error('Install the GitHub App on this repository to build from source'));
    await expect(mintCloneCredential('https://github.com/acme/app.git', 'b1')).rejects.toThrow('Install the GitHub App');
  });

  it('creates a read_repository deploy token per GitLab build and revokes it by id', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { id: 42, username: 'gitlab+deploy-token-42', token: 'gldt-secret' }));
    const cred = await mintCloneCredential('https://gitlab.com/group/app.git', 'b1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gitlab.com/api/v4/projects/group%2Fapp/deploy_tokens');
    expect(JSON.parse(init.body).scopes).toEqual(['read_repository']);
    expect(cred.header).toBe(`Authorization: Basic ${Buffer.from('gitlab+deploy-token-42:gldt-secret').toString('base64')}`);
    expect(cred.header).not.toContain('glpat');
    fetchMock.mockResolvedValueOnce(json(204, {}));
    await revokeCloneCredential(cred.revoke);
    expect(fetchMock.mock.calls[1][0]).toBe('https://gitlab.com/api/v4/projects/group%2Fapp/deploy_tokens/42');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });

  it('refuses GitLab builds with a clear message when no deploy token can be issued', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { message: 'forbidden' }));
    await expect(mintCloneCredential('https://gitlab.com/group/app.git', 'b1')).rejects.toThrow(/deploy token/);
    mockGitlabToken.mockResolvedValueOnce('');
    await expect(mintCloneCredential('https://gitlab.com/group/app.git', 'b1')).rejects.toThrow(/GitLab token/);
  });

  it('refuses unsupported origins', async () => {
    await expect(mintCloneCredential('https://evil.invalid/acme/app.git', 'b1')).rejects.toThrow('linked');
  });
});

describe('webhook commit verification', () => {
  it('accepts the branch head and revokes the verification token', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { commit: { sha } }));
    expect(await verifyCommitOnBranch('https://github.com/acme/app.git', 'main', sha)).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/app/branches/main');
    expect(mockRevoke).toHaveBeenCalledWith('ghs_scoped_token');
  });

  it('accepts an ancestor of the branch head', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { commit: { sha: head } })).mockResolvedValueOnce(json(200, { status: 'ahead', merge_base_commit: { sha } }));
    expect(await verifyCommitOnBranch('https://github.com/acme/app.git', 'main', sha)).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe(`https://api.github.com/repos/acme/app/compare/${sha}...${head}`);
  });

  it.each([
    ['a diverged (for example fork-only) commit', json(200, { status: 'diverged', merge_base_commit: { sha: 'c'.repeat(40) } })],
    ['a commit newer than the branch head', json(200, { status: 'behind', merge_base_commit: { sha: head } })],
    ['a commit unknown to the repository', json(404, { message: 'Not Found' })],
  ])('rejects %s', async (_label, compare) => {
    fetchMock.mockResolvedValueOnce(json(200, { commit: { sha: head } })).mockResolvedValueOnce(compare);
    expect(await verifyCommitOnBranch('https://github.com/acme/app.git', 'main', sha)).toBe(false);
    expect(mockRevoke).toHaveBeenCalled();
  });

  it('rejects a missing branch and malformed SHAs without calling the provider', async () => {
    fetchMock.mockResolvedValueOnce(json(404, {}));
    expect(await verifyCommitOnBranch('https://github.com/acme/app.git', 'gone', sha)).toBe(false);
    fetchMock.mockClear();
    expect(await verifyCommitOnBranch('https://github.com/acme/app.git', 'main', 'unknown')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies GitLab pushes with the merge base of the branch head', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { commit: { id: head } })).mockResolvedValueOnce(json(200, { id: sha }));
    expect(await verifyCommitOnBranch('https://gitlab.com/group/app.git', 'main', sha)).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toContain(`/repository/merge_base?refs[]=${sha}&refs[]=${head}`);
    fetchMock.mockResolvedValueOnce(json(200, { commit: { id: head } })).mockResolvedValueOnce(json(200, { id: 'c'.repeat(40) }));
    expect(await verifyCommitOnBranch('https://gitlab.com/group/app.git', 'main', sha)).toBe(false);
  });
});
