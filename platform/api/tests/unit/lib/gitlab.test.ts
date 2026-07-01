const originalFetch = global.fetch;

describe('GitLab Library', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('triggerPipeline', () => {
    it('should call GitLab API to trigger pipeline', async () => {
      process.env.GITLAB_TOKEN = 'test-token';
      process.env.GITLAB_API_URL = 'https://gitlab.example.com/api/v4';
      const mockFetch = jest.fn().mockResolvedValue({ ok: true });
      global.fetch = mockFetch;

      const { triggerPipeline } = await import('../../../src/lib/gitlab');
      await triggerPipeline('my-project', 'main');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/trigger/pipeline'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should handle errors silently', async () => {
      process.env.GITLAB_TOKEN = 'test-token';
      process.env.GITLAB_API_URL = 'https://gitlab.example.com/api/v4';
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const { triggerPipeline } = await import('../../../src/lib/gitlab');
      await expect(triggerPipeline('my-project', 'main')).resolves.not.toThrow();
    });
  });

  describe('getGitlabUser', () => {
    it('should fetch user data from GitLab', async () => {
      process.env.GITLAB_TOKEN = 'test-token';
      process.env.GITLAB_API_URL = 'https://gitlab.example.com/api/v4';
      const userData = { id: 1, name: 'John Doe' };
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => userData,
      });
      global.fetch = mockFetch;

      const { getGitlabUser } = await import('../../../src/lib/gitlab');
      const result = await getGitlabUser('123');

      expect(result).toEqual(userData);
    });

    it('should return null when user not found', async () => {
      process.env.GITLAB_TOKEN = 'test-token';
      process.env.GITLAB_API_URL = 'https://gitlab.example.com/api/v4';
      global.fetch = jest.fn().mockResolvedValue({ ok: false });

      const { getGitlabUser } = await import('../../../src/lib/gitlab');
      const result = await getGitlabUser('999');

      expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
      process.env.GITLAB_TOKEN = 'test-token';
      process.env.GITLAB_API_URL = 'https://gitlab.example.com/api/v4';
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const { getGitlabUser } = await import('../../../src/lib/gitlab');
      const result = await getGitlabUser('123');

      expect(result).toBeNull();
    });
  });
});
