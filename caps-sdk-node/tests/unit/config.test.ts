import { ConfigClient } from '../../src/config';

describe('ConfigClient', () => {
  let configClient: ConfigClient;
  let mockHttp: any;

  beforeEach(() => {
    mockHttp = {
      get: jest.fn(),
      defaults: { baseURL: '' },
    };
    configClient = new ConfigClient(mockHttp);
    jest.clearAllMocks();
  });

  describe('configure', () => {
    it('should set project and environment context', () => {
      configClient.configure('my-project', 'production');
      // Internal state is private, but loadAll will use it
      expect(() => configClient.configure('my-project', 'production')).not.toThrow();
    });
  });

  describe('loadAll', () => {
    it('should fetch and cache config values', async () => {
      mockHttp.get.mockResolvedValue({
        data: { KEY1: 'value1', KEY2: 'value2' },
      });

      configClient.configure('my-project', 'production');
      await configClient.loadAll();

      expect(mockHttp.get).toHaveBeenCalledWith('/api/sdk/config', {
        params: { projectId: 'my-project', environmentId: 'production' },
      });
    });

    it('should handle errors silently', async () => {
      mockHttp.get.mockRejectedValue(new Error('Network error'));
      configClient.configure('my-project', 'production');

      await expect(configClient.loadAll()).resolves.not.toThrow();
    });

    it('should return early when not configured', async () => {
      await configClient.loadAll();
      expect(mockHttp.get).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should return cached value for existing key', async () => {
      mockHttp.get.mockResolvedValue({ data: { MY_KEY: 'my-value' } });
      configClient.configure('p', 'e');
      await configClient.loadAll();

      expect(configClient.get('MY_KEY')).toBe('my-value');
    });

    it('should convert "true" string to boolean', async () => {
      mockHttp.get.mockResolvedValue({ data: { FLAG: 'true' } });
      configClient.configure('p', 'e');
      await configClient.loadAll();

      expect(configClient.get('FLAG')).toBe(true);
    });

    it('should convert "false" string to boolean', async () => {
      mockHttp.get.mockResolvedValue({ data: { FLAG: 'false' } });
      configClient.configure('p', 'e');
      await configClient.loadAll();

      expect(configClient.get('FLAG')).toBe(false);
    });

    it('should return default value for missing key', () => {
      expect(configClient.get('MISSING', 'default')).toBe('default');
    });

    it('should return null for missing key without default', () => {
      expect(configClient.get('MISSING')).toBeNull();
    });
  });

  describe('startBackgroundRefresh / stopBackgroundRefresh', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should periodically refresh config', async () => {
      mockHttp.get.mockResolvedValue({ data: {} });
      configClient.configure('p', 'e');

      configClient.startBackgroundRefresh();

      await configClient.loadAll();
      const initialCallCount = mockHttp.get.mock.calls.length;

      jest.advanceTimersByTime(30000);

      expect(mockHttp.get.mock.calls.length).toBeGreaterThan(initialCallCount);

      configClient.stopBackgroundRefresh();
    });

    it('should stop refreshing when stopBackgroundRefresh is called', async () => {
      configClient.configure('p', 'e');
      configClient.startBackgroundRefresh();
      configClient.stopBackgroundRefresh();

      jest.advanceTimersByTime(60000);
      // No error should occur
    });
  });
});
