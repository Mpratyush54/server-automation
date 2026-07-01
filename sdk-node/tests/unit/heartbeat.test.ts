import { HeartbeatClient } from '../../src/heartbeat';
import { PlatformOptions } from '../../src/client';

describe('HeartbeatClient', () => {
  let heartbeatClient: HeartbeatClient;
  let mockHttp: any;
  const options: PlatformOptions = {
    projectName: 'test-project',
    environmentName: 'production',
    platformUrl: 'http://localhost:3000',
  };

  beforeEach(() => {
    mockHttp = { post: jest.fn().mockResolvedValue({ status: 200 }) };
    heartbeatClient = new HeartbeatClient(mockHttp, options);
    jest.clearAllMocks();
  });

  describe('setDbHealth', () => {
    it('should store DB health data', () => {
      const health = [
        { dbType: 'postgres', status: 'connected' },
        { dbType: 'redis', status: 'disconnected' },
      ];

      expect(() => heartbeatClient.setDbHealth(health)).not.toThrow();
    });
  });

  describe('send', () => {
    it('should send heartbeat to API', async () => {
      await heartbeatClient.send();

      expect(mockHttp.post).toHaveBeenCalledWith('/api/sdk/heartbeat', expect.objectContaining({
        projectId: 'test-project',
        serviceName: 'test-project',
        dbHealth: [],
        timestamp: expect.any(String),
      }));
    });

    it('should include DB health data in heartbeat', async () => {
      heartbeatClient.setDbHealth([
        { dbType: 'postgres', status: 'connected', metrics: { activeCount: 2 } },
      ]);

      await heartbeatClient.send();

      expect(mockHttp.post).toHaveBeenCalledWith('/api/sdk/heartbeat', expect.objectContaining({
        dbHealth: expect.arrayContaining([
          expect.objectContaining({ dbType: 'postgres', status: 'connected' }),
        ]),
      }));
    });

    it('should handle errors silently', async () => {
      mockHttp.post.mockRejectedValue(new Error('Network error'));

      await expect(heartbeatClient.send()).resolves.not.toThrow();
    });

    it('should include ISO timestamp', async () => {
      await heartbeatClient.send();

      const call = mockHttp.post.mock.calls[0];
      const timestamp = call[1].timestamp;
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
    });
  });
});
