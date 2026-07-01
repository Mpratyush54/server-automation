import axios from 'axios';

jest.mock('axios');
const mockPost = axios.post as jest.MockedFunction<typeof axios.post>;

import { forwardToLoki } from '../../../src/lib/lokilog';

describe('Loki Log Library', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LOKI_URL;
    mockPost.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should send logs to Loki', async () => {
    process.env.LOKI_URL = 'http://loki:3100';
    mockPost.mockResolvedValue({ status: 204 } as any);

    const logs = [
      {
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceName: 'my-service',
        level: 'INFO',
        message: 'Test log',
      },
    ];

    await forwardToLoki(logs);

    expect(mockPost).toHaveBeenCalledWith(
      'http://loki:3100/loki/api/v1/push',
      expect.objectContaining({
        streams: expect.arrayContaining([
          expect.objectContaining({
            stream: expect.objectContaining({
              project_id: 'proj-1',
              level: 'INFO',
            }),
          }),
        ]),
      }),
      expect.objectContaining({ timeout: 3000 })
    );
  });

  it('should use default Loki URL', async () => {
    mockPost.mockResolvedValue({ status: 204 } as any);

    await forwardToLoki([{ projectId: 'p', environmentId: 'e', serviceName: 's', level: 'INFO', message: 'm' }]);

    expect(mockPost).toHaveBeenCalledWith(
      'http://localhost:3100/loki/api/v1/push',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('should handle errors silently', async () => {
    mockPost.mockRejectedValue(new Error('Connection refused'));

    await expect(
      forwardToLoki([{ projectId: 'p', environmentId: 'e', serviceName: 's', level: 'INFO', message: 'm' }])
    ).resolves.not.toThrow();
  });
});
