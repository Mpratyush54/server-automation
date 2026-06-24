import { fetchSecrets } from '../../../src/lib/infisical';

describe('Infisical Library', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.INFISICAL_TOKEN;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('should return empty object when no INFISICAL_TOKEN is set', async () => {
    const result = await fetchSecrets('project-1', 'production');
    expect(result).toEqual({});
  });

  it('should fetch secrets when token is set', async () => {
    process.env.INFISICAL_TOKEN = 'test-token';
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        secrets: [
          { secretKey: 'DB_HOST', secretValue: 'localhost' },
          { secretKey: 'DB_PORT', secretValue: '5432' },
        ],
      }),
    });
    global.fetch = mockFetch;

    const result = await fetchSecrets('project-1', 'production');

    expect(result).toEqual({ DB_HOST: 'localhost', DB_PORT: '5432' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('workspaceId=project-1'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      })
    );
  });

  it('should return empty object on API error', async () => {
    process.env.INFISICAL_TOKEN = 'test-token';
    const mockFetch = jest.fn().mockResolvedValue({ ok: false });
    global.fetch = mockFetch;

    const result = await fetchSecrets('project-1', 'production');
    expect(result).toEqual({});
  });

  it('should return empty object on network error', async () => {
    process.env.INFISICAL_TOKEN = 'test-token';
    const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'));
    global.fetch = mockFetch;

    const result = await fetchSecrets('project-1', 'production');
    expect(result).toEqual({});
  });

  it('should return empty object when response has no secrets', async () => {
    process.env.INFISICAL_TOKEN = 'test-token';
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    global.fetch = mockFetch;

    const result = await fetchSecrets('project-1', 'production');
    expect(result).toEqual({});
  });
});
