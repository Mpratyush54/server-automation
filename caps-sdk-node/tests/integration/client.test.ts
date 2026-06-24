import axios from 'axios';
import { CapsClient, CapsOptions } from '../../src/client';

jest.mock('axios');
jest.mock('../../src/db/postgres', () => ({
  PostgresManager: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: true,
    health: { connected: true, poolSize: 10 },
  })),
}));
jest.mock('../../src/db/mongo', () => ({
  MongoManager: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: true,
    health: { connected: true },
  })),
}));
jest.mock('../../src/db/redis', () => ({
  RedisManager: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: true,
    health: { connected: true },
  })),
}));

describe('CapsClient Integration', () => {
  let client: CapsClient;
  let mockAxiosInstance: any;

  beforeEach(() => {
    jest.useFakeTimers();
    mockAxiosInstance = {
      post: jest.fn().mockResolvedValue({ data: {} }),
      get: jest.fn().mockResolvedValue({ data: {} }),
      put: jest.fn().mockResolvedValue({}),
      defaults: { baseURL: '' },
      create: jest.fn().mockReturnThis(),
    };

    (axios.create as jest.Mock).mockReturnValue(mockAxiosInstance);
    client = new CapsClient();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('init', () => {
    it('should initialize with default options', async () => {
      mockAxiosInstance.post
        .mockResolvedValueOnce({ data: { id: 'reg-1' } }) // register
        .mockResolvedValueOnce({ data: {} }); // heartbeat
      mockAxiosInstance.get.mockResolvedValue({ data: {} }); // config

      await client.init({
        projectName: 'test-project',
        platformUrl: 'http://localhost:3000',
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/sdk/register', expect.objectContaining({
        projectName: 'test-project',
      }));
    });

    it('should handle registration failure gracefully', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('Registration failed'));
      mockAxiosInstance.get.mockResolvedValue({ data: {} });

      await expect(client.init({
        projectName: 'test-project',
        platformUrl: 'http://localhost:3000',
      })).resolves.not.toThrow();
    });

    it('should configure DB managers when databases are specified', async () => {
      mockAxiosInstance.post
        .mockResolvedValueOnce({ data: { id: 'reg-1' } })
        .mockResolvedValue({ data: { postgres: {}, mongo: {}, redis: {} } });
      mockAxiosInstance.get.mockResolvedValue({ data: {} });

      await client.init({
        projectName: 'test-project',
        platformUrl: 'http://localhost:3000',
        databases: ['postgres', 'mongo', 'redis'],
      });

      expect(client.db.postgres).toBeDefined();
      expect(client.db.mongo).toBeDefined();
      expect(client.db.redis).toBeDefined();
    });

    it('should set baseURL on the http instance', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: {} });
      mockAxiosInstance.get.mockResolvedValue({ data: {} });

      await client.init({
        projectName: 'test-project',
        platformUrl: 'http://localhost:3000',
      });

      expect(mockAxiosInstance.defaults.baseURL).toBe('http://localhost:3000');
    });
  });

  describe('config', () => {
    it('should delegate to configClient', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: {} });
      mockAxiosInstance.get.mockResolvedValue({ data: { MY_KEY: 'my-value' } });

      await client.init({
        projectName: 'test-project',
        platformUrl: 'http://localhost:3000',
      });

      expect(client.config('MY_KEY')).toBe('my-value');
    });
  });

  describe('shutdown', () => {
    it('should cleanup all resources', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: {} });
      mockAxiosInstance.get.mockResolvedValue({ data: {} });

      await client.init({
        projectName: 'test-project',
        platformUrl: 'http://localhost:3000',
        databases: ['postgres'],
      });

      await client.shutdown();

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/sdk/deregister', expect.objectContaining({
        projectId: 'test-project',
      }));
    });

    it('should handle shutdown errors gracefully', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('Network error'));

      await expect(client.shutdown()).resolves.not.toThrow();
    });
  });

  describe('public sub-clients', () => {
    it('should expose registration client', () => {
      expect(client.registration).toBeDefined();
      expect(typeof client.registration.register).toBe('function');
    });

    it('should expose logger client', () => {
      expect(client.logger).toBeDefined();
      expect(typeof client.logger.info).toBe('function');
    });

    it('should expose configClient', () => {
      expect(client.configClient).toBeDefined();
      expect(typeof client.configClient.get).toBe('function');
    });

    it('should expose storage client', () => {
      expect(client.storage).toBeDefined();
      expect(typeof client.storage.upload).toBe('function');
    });
  });
});
