import { RegistrationClient } from '../../src/registration';

describe('RegistrationClient', () => {
  let registrationClient: RegistrationClient;
  let mockHttp: any;

  beforeEach(() => {
    mockHttp = {
      post: jest.fn(),
      get: jest.fn(),
    };
    registrationClient = new RegistrationClient(mockHttp);
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should send registration payload to API', async () => {
      const responseData = { id: 'reg-1', projectName: 'test-project' };
      mockHttp.post.mockResolvedValue({ data: responseData });

      const result = await registrationClient.register({
        projectName: 'test-project',
        environmentName: 'production',
        serviceName: 'test-service',
        version: '1.0.0',
        branch: 'main',
      });

      expect(result).toEqual(responseData);
      expect(mockHttp.post).toHaveBeenCalledWith('/api/sdk/register', {
        projectName: 'test-project',
        environmentName: 'production',
        serviceName: 'test-service',
        version: '1.0.0',
        branch: 'main',
        commitSha: undefined,
        namespace: undefined,
        hostname: undefined,
        metadata: undefined,
        dbTypes: undefined,
        infisicalEnv: undefined,
      });
    });

    it('should return null on error', async () => {
      mockHttp.post.mockRejectedValue(new Error('Network error'));

      const result = await registrationClient.register({
        projectName: 'test-project',
        environmentName: 'production',
        serviceName: 'test-service',
        version: '1.0.0',
      });

      expect(result).toBeNull();
    });
  });

  describe('deregister', () => {
    it('should send deregister request', async () => {
      mockHttp.post.mockResolvedValue({});

      await registrationClient.deregister('project-1', 'service-1');

      expect(mockHttp.post).toHaveBeenCalledWith('/api/sdk/deregister', {
        projectId: 'project-1',
        serviceName: 'service-1',
      });
    });

    it('should handle errors silently', async () => {
      mockHttp.post.mockRejectedValue(new Error('Network error'));

      await expect(registrationClient.deregister('p', 's')).resolves.not.toThrow();
    });
  });

  describe('getDbCredentials', () => {
    it('should fetch DB credentials for specified types', async () => {
      const creds = { postgres: { host: 'localhost', port: 5432 } };
      mockHttp.get.mockResolvedValue({ data: creds });

      const result = await registrationClient.getDbCredentials('project-1', ['postgres']);

      expect(result).toEqual(creds);
      expect(mockHttp.get).toHaveBeenCalledWith('/api/sdk/db-credentials', {
        params: { projectId: 'project-1', dbTypes: 'postgres' },
      });
    });

    it('should handle multiple DB types', async () => {
      mockHttp.get.mockResolvedValue({ data: { postgres: {}, mongo: {} } });

      await registrationClient.getDbCredentials('p', ['postgres', 'mongo']);

      expect(mockHttp.get).toHaveBeenCalledWith('/api/sdk/db-credentials', {
        params: { projectId: 'p', dbTypes: 'postgres,mongo' },
      });
    });

    it('should return empty object on error', async () => {
      mockHttp.get.mockRejectedValue(new Error('Network error'));

      const result = await registrationClient.getDbCredentials('p', ['postgres']);
      expect(result).toEqual({});
    });
  });
});
