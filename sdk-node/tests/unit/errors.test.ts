import { PlatformClient } from '../../src/client';

test('captureException uses version, parses V8 coordinates and tolerates delivery failure', async () => {
  const client = new PlatformClient();
  const internals = client as any;
  internals.options = { version: '1.2.3', environmentName: 'production' };
  internals.http.post = jest.fn().mockResolvedValue({});
  const error = new TypeError('cart failed');
  error.stack = 'TypeError: cart failed\n    at checkout (/app/cart.js:12:4)\n    at /app/main.js:20:1';
  await client.captureException(error, { sessionId: 'opaque-session' });
  expect(internals.http.post).toHaveBeenCalledWith('/api/sdk/errors', expect.objectContaining({
    type: 'TypeError', release: '1.2.3', environment: 'production', sessionId: 'opaque-session',
    frames: [{ file: '/app/cart.js', function: 'checkout', line: 12, column: 3 }, { file: '/app/main.js', function: undefined, line: 20, column: 0 }],
  }), { timeout: 5000 });
  internals.http.post.mockRejectedValue(new Error('offline'));
  await expect(client.captureException(error)).resolves.toBeUndefined();
});
