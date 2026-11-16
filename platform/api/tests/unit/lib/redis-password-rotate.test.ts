import { dropPreviousSentinelPassword, rotateSentinelPassword } from '../../../src/lib/redis-password-rotate';
import { deriveApiRedisPassword } from '../../../src/lib/redis';
import { deriveSentinelPassword } from '../../../src/lib/redis-endpoint';

const mockNodes = new Map<string, { passwords: Set<string>; users: Map<string, Set<string>> }>();
const mockCommands: string[][] = [];
let mockFail = '';
let mockRewriteError = '';
const mockDisconnect = jest.fn();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class {
    constructor(private opts: any) {}
    on() {}
    disconnect = mockDisconnect;
    async connect() {
      if (!this.node.passwords.has(this.opts.password)) throw new Error('WRONGPASS');
    }
    get label() { return `${this.opts.host}:${this.opts.port}`; }
    get node() { return mockNodes.get(this.label)!; }
    async ping() { return 'PONG'; }
    async auth(password: string) {
      if (!this.node.passwords.has(password)) throw new Error('WRONGPASS');
    }
    async config(...args: string[]) { return this.call('CONFIG', ...args); }
    async call(...args: string[]): Promise<any> {
      const command = [this.label, ...args];
      mockCommands.push(command);
      if (command.join(' ') === mockFail) throw new Error(`failed ${args.join(' ')}`);
      if (args[0] === 'CONFIG' && args[1] === 'REWRITE' && mockRewriteError) throw new Error(mockRewriteError);
      if (args[0] === 'CONFIG' && args[2] === 'requirepass') this.node.passwords = new Set([args[3]]);
      if (args[0] === 'ACL' && args[1] === 'SETUSER') {
        const passwords = args[2] === 'default' ? this.node.passwords : (this.node.users.get(args[2]) || new Set<string>());
        if (args.includes('reset') || args.includes('resetpass')) passwords.clear();
        args.filter((a) => a.startsWith('>')).forEach((a) => passwords.add(a.slice(1)));
        this.node.users.set(args[2], passwords);
      }
      if (args[1] === 'get-master-addr-by-name') return ['redis-node-0.redis-headless', '6379'];
      if (args[1] === 'replicas') return [['ip', 'redis-node-1.redis-headless', 'port', '6379', 'flags', 'slave']];
      if (args[1] === 'sentinels') return [['ip', 'redis-node-2.redis-headless', 'port', '26379']];
      return 'OK';
    }
  },
}));

const env = { ...process.env };
beforeEach(() => {
  mockNodes.clear();
  mockCommands.length = 0;
  mockFail = '';
  mockRewriteError = '';
  mockDisconnect.mockClear();
  process.env.REDIS_SENTINEL_HOSTS = 'redis-node-0.redis-headless:26379,redis-node-1.redis-headless:26379,redis-node-2.redis-headless:26379';
  delete process.env.REDIS_SENTINEL_PASSWORD;
  delete process.env.REDIS_API_USERNAME;
  for (let i = 0; i < 3; i++) {
    for (const port of [6379, 26379]) {
      mockNodes.set(`redis-node-${i}.redis-headless:${port}`, {
        passwords: new Set(['old']), users: new Map([['plat_project', new Set(['project-password'])]]),
      });
    }
  }
});
afterEach(() => { process.env = { ...env }; });

it('rotates all nodes in phases, including a replica absent from discovery, and preserves ACL clients', async () => {
  await rotateSentinelPassword('old', 'new');
  const commands = mockCommands.map((c) => c.join(' '));
  const masterauth = commands.map((c, i) => c.includes('CONFIG SET masterauth') ? i : -1).filter((i) => i >= 0);
  const requirepass = commands.map((c, i) => c.includes('CONFIG SET requirepass') ? i : -1).filter((i) => i >= 0);
  const authpass = commands.map((c, i) => c.includes('SENTINEL SET mymaster auth-pass') ? i : -1).filter((i) => i >= 0);
  expect(masterauth).toHaveLength(3);
  expect(requirepass).toHaveLength(3);
  expect(authpass).toHaveLength(3);
  expect(Math.max(...masterauth)).toBeLessThan(Math.min(...requirepass));
  expect(Math.max(...requirepass)).toBeLessThan(Math.min(...authpass));
  for (const [label, node] of mockNodes) {
    // Old stays valid until the delayed drop: probes read the Secret mount, which lags.
    expect(node.passwords).toEqual(new Set(['old', 'new']));
    expect(node.users.get('plat_project')).toEqual(new Set(['project-password']));
    const user = label.endsWith(':6379') ? 'plat-api' : 'plat-sentinel';
    const derive = label.endsWith(':6379') ? deriveApiRedisPassword : deriveSentinelPassword;
    expect(node.users.get(user)).toEqual(new Set([derive('old'), derive('new')]));
  }
  expect(commands.filter((c) => c.includes('CONFIG REWRITE'))).toHaveLength(3);
  expect(commands.filter((c) => c.includes('SENTINEL FLUSHCONFIG'))).toHaveLength(3);
  expect(mockDisconnect).toHaveBeenCalled();
});

it.each([
  'redis-node-1.redis-headless:6379 CONFIG SET masterauth new',
  'redis-node-1.redis-headless:6379 CONFIG SET requirepass new',
  'redis-node-1.redis-headless:26379 SENTINEL SET mymaster auth-pass new',
  'redis-node-1.redis-headless:26379 SENTINEL FLUSHCONFIG',
])('resumes after failure at %s without skipping remaining members', async (failure) => {
  mockFail = failure;
  await expect(rotateSentinelPassword('old', 'new')).rejects.toThrow('rotation incomplete');
  mockFail = '';
  await rotateSentinelPassword('old', 'new');
  for (const node of mockNodes.values()) expect(node.passwords).toEqual(new Set(['old', 'new']));
});

it('preflights every member and makes no changes when a node is unavailable', async () => {
  mockNodes.get('redis-node-2.redis-headless:6379')!.passwords.clear();
  await expect(rotateSentinelPassword('old', 'new')).rejects.toThrow('rotation incomplete');
  expect(mockCommands.some((c) => c[0].endsWith(':6379'))).toBe(false);
});

it('retains a separately configured Sentinel password', async () => {
  process.env.REDIS_SENTINEL_PASSWORD = 'separate';
  for (const [label, node] of mockNodes) if (label.endsWith(':26379')) node.passwords = new Set(['separate']);
  await rotateSentinelPassword('old', 'new');
  for (const [label, node] of mockNodes) expect(node.passwords).toEqual(new Set(label.endsWith(':26379') ? ['separate'] : ['old', 'new']));
  await dropPreviousSentinelPassword('new');
  for (const [label, node] of mockNodes) expect(node.passwords).toEqual(new Set([label.endsWith(':26379') ? 'separate' : 'new']));
});

it('drops the previous default and plat-api passwords, keeps one previous plat-sentinel password, and is idempotent', async () => {
  await rotateSentinelPassword('old', 'new');
  await dropPreviousSentinelPassword('new', 'old');
  const check = () => {
    for (const [label, node] of mockNodes) {
      expect(node.passwords).toEqual(new Set(['new']));
      expect(node.users.get('plat_project')).toEqual(new Set(['project-password']));
      if (label.endsWith(':6379')) {
        expect(node.users.get('plat-api')).toEqual(new Set([deriveApiRedisPassword('new')]));
      } else {
        expect(node.users.get('plat-sentinel')).toEqual(new Set([deriveSentinelPassword('new'), deriveSentinelPassword('old')]));
      }
    }
  };
  check();
  mockCommands.length = 0;
  await dropPreviousSentinelPassword('new', 'old');
  check();
  // Each ACL change is a single atomic SETUSER with resetpass: no window without a password.
  expect(mockCommands.filter((c) => c[1] === 'ACL').every((c) => c.includes('resetpass'))).toBe(true);
});

it("removes the older plat-sentinel password on the next rotation's drop", async () => {
  await rotateSentinelPassword('old', 'new');
  await dropPreviousSentinelPassword('new', 'old');
  await rotateSentinelPassword('new', 'newer');
  await dropPreviousSentinelPassword('newer', 'new');
  for (const [label, node] of mockNodes) {
    if (!label.endsWith(':26379')) continue;
    expect(node.users.get('plat-sentinel')).toEqual(new Set([deriveSentinelPassword('newer'), deriveSentinelPassword('new')]));
    expect(node.users.get('plat-sentinel')!.has(deriveSentinelPassword('old'))).toBe(false);
  }
});

it('refuses to drop when a member does not accept the new password yet, changing nothing', async () => {
  await rotateSentinelPassword('old', 'new');
  mockNodes.get('redis-node-2.redis-headless:6379')!.passwords = new Set(['old']);
  mockCommands.length = 0;
  await expect(dropPreviousSentinelPassword('new')).rejects.toThrow('stays valid');
  expect(mockCommands.some((c) => c.includes('resetpass'))).toBe(false);
  expect(mockNodes.get('redis-node-0.redis-headless:6379')!.passwords).toEqual(new Set(['old', 'new']));
});

it('tolerates read-only data config but propagates unexpected persistence failures', async () => {
  mockRewriteError = 'Read-only file system';
  await expect(rotateSentinelPassword('old', 'new')).resolves.toBeUndefined();
  mockRewriteError = 'disk full';
  await expect(rotateSentinelPassword('old', 'new')).rejects.toThrow('rotation incomplete');
});
