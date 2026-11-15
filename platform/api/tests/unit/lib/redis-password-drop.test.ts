/**
 * Delayed drop of the previous Redis Sentinel password (lib/redis-password-drop): the old
 * password survives the rotation request, a durable follow-up operation removes it once the
 * Secret had time to reach the pods, re-running is a no-op, and it resumes after a restart.
 */
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue({ getRepository: () => ({}) }),
}));

const mockSecrets: Record<string, Record<string, string>> = {};
jest.mock('../../../src/lib/k8s', () => ({
  readSecretData: jest.fn(async (ns: string, name: string) => {
    const data = mockSecrets[`${ns}/${name}`];
    if (!data) throw Object.assign(new Error('not found'), { code: 404 });
    return { ...data };
  }),
}));

const mockNodes = new Map<string, { passwords: Set<string>; users: Map<string, Set<string>> }>();
const mockCommands: string[][] = [];
let mockFail = '';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class {
    constructor(private opts: any) {}
    on() {}
    disconnect() {}
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
      if (mockFail && command.join(' ').startsWith(mockFail)) throw new Error('failed');
      if (args[0] === 'CONFIG' && args[2] === 'requirepass') this.node.passwords = new Set([args[3]]);
      if (args[0] === 'ACL' && args[1] === 'SETUSER') {
        const passwords = args[2] === 'default' ? this.node.passwords : (this.node.users.get(args[2]) || new Set<string>());
        if (args.includes('resetpass')) passwords.clear();
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

import { getOperation, resumeOperations, runOperation, setOperationStore, waitForActiveRuns } from '../../../src/lib/operations';
import { MemoryOperationStore } from '../../../src/lib/operation-store';
import { resetMemoryLocksForTests } from '../../../src/lib/locks';
import { setCoordinationRedisForTests } from '../../../src/lib/coord-redis';
import { rotateSentinelPassword } from '../../../src/lib/redis-password-rotate';
import {
  REDIS_DROP_DELAY_MS, REDIS_DROP_MAX_TRIES, REDIS_DROP_RETRY_MS, redisDropOperationId, scheduleRedisPasswordDrop,
} from '../../../src/lib/redis-password-drop';
import { deriveApiRedisPassword } from '../../../src/lib/redis';
import { deriveSentinelPassword } from '../../../src/lib/redis-endpoint';

let store: MemoryOperationStore;
let now = 1_800_000_000_000;
const env = { ...process.env };

/** What the leader's resume job does every minute (and right after an API restart). */
async function sweep() {
  const res = await resumeOperations();
  await waitForActiveRuns();
  return res;
}

function oldValid(): boolean {
  return [...mockNodes.values()].every((n) => n.passwords.has('old'));
}

function onlyNew() {
  for (const [label, node] of mockNodes) {
    expect(node.passwords).toEqual(new Set(['new']));
    const user = label.endsWith(':6379') ? 'plat-api' : 'plat-sentinel';
    const derive = label.endsWith(':6379') ? deriveApiRedisPassword : deriveSentinelPassword;
    expect(node.users.get(user)).toEqual(new Set([derive('new')]));
  }
}

beforeEach(() => {
  store = new MemoryOperationStore();
  setOperationStore(store);
  setCoordinationRedisForTests(null);
  resetMemoryLocksForTests();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockNodes.clear();
  mockCommands.length = 0;
  mockFail = '';
  for (const k of Object.keys(mockSecrets)) delete mockSecrets[k];
  mockSecrets['databases/redis'] = { 'redis-password': 'new' };
  process.env.REDIS_SENTINEL_HOSTS = 'redis-node-0.redis-headless:26379,redis-node-1.redis-headless:26379,redis-node-2.redis-headless:26379';
  delete process.env.REDIS_SENTINEL_PASSWORD;
  delete process.env.REDIS_API_USERNAME;
  for (let i = 0; i < 3; i++) {
    for (const port of [6379, 26379]) {
      mockNodes.set(`redis-node-${i}.redis-headless:${port}`, { passwords: new Set(['old']), users: new Map() });
    }
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...env };
});

it('keeps the old password valid after the request and drops it in the delayed step', async () => {
  await rotateSentinelPassword('old', 'new');
  const { operationId, notBefore } = await scheduleRedisPasswordDrop({ rotationOperationId: 'rot-1', next: 'new' });
  expect(notBefore.getTime()).toBe(now + REDIS_DROP_DELAY_MS);
  expect(REDIS_DROP_DELAY_MS).toBeGreaterThanOrEqual(120_000);
  expect(oldValid()).toBe(true);

  // First sweep: not due yet, so it waits without touching Redis.
  mockCommands.length = 0;
  await sweep();
  let op = (await getOperation(operationId))!;
  expect(op.status).toBe('pending');
  expect(new Date(op.steps[0].output?.waitingUntil as string).getTime()).toBe(notBefore.getTime());
  expect(op.steps[0].attempts).toBe(0);
  expect(mockCommands).toHaveLength(0);
  expect(oldValid()).toBe(true);

  // Later sweeps before the deadline skip it entirely.
  now += REDIS_DROP_DELAY_MS - 1_000;
  expect((await sweep()).resumed).not.toContain(operationId);
  expect(oldValid()).toBe(true);

  now += 1_000;
  await sweep();
  op = (await getOperation(operationId))!;
  expect(op.status).toBe('succeeded');
  expect(op.steps[0].output).toEqual({ dropped: true });
  expect(op.state).toEqual({}); // sensitive state wiped once terminal
  onlyNew();
});

it('re-running is a no-op: same operation, and a finished one is not run again', async () => {
  await rotateSentinelPassword('old', 'new');
  const first = await scheduleRedisPasswordDrop({ rotationOperationId: 'rot-1', next: 'new' });
  const again = await scheduleRedisPasswordDrop({ rotationOperationId: 'rot-1', next: 'new' });
  expect(again.operationId).toBe(first.operationId);
  expect(first.operationId).toBe(redisDropOperationId('rot-1'));
  expect(redisDropOperationId('rot-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  now += REDIS_DROP_DELAY_MS;
  await sweep();
  onlyNew();
  mockCommands.length = 0;
  await sweep();
  await runOperation(first.operationId);
  expect(mockCommands).toHaveLength(0);
  onlyNew();
});

it('resumes after the API was killed in the middle of the step', async () => {
  await rotateSentinelPassword('old', 'new');
  const { operationId } = await scheduleRedisPasswordDrop({ rotationOperationId: 'rot-1', next: 'new' });
  now += REDIS_DROP_DELAY_MS;

  // The pod died while the step was running: the persisted record says "running",
  // the lock lapsed, and Redis was partly changed (one data node already dropped).
  const rec = (await store.claim(operationId, 'dead-runner'))!;
  rec.status = 'running';
  rec.steps[0].status = 'running';
  rec.steps[0].attempts = 1;
  await store.save(rec, 'dead-runner');
  mockNodes.get('redis-node-0.redis-headless:6379')!.passwords = new Set(['new']);

  // The new leader's first sweep after boot picks it up and finishes.
  const res = await sweep();
  expect(res.resumed).toContain(operationId);
  const op = (await getOperation(operationId))!;
  expect(op.status).toBe('succeeded');
  expect(op.attempts).toBe(2);
  onlyNew();
});

it('retries later when a member is unreachable, then completes', async () => {
  await rotateSentinelPassword('old', 'new');
  const { operationId } = await scheduleRedisPasswordDrop({ rotationOperationId: 'rot-1', next: 'new' });
  now += REDIS_DROP_DELAY_MS;
  mockFail = 'redis-node-1.redis-headless:26379 ACL SETUSER';
  await sweep();
  let op = (await getOperation(operationId))!;
  expect(op.status).toBe('pending');
  expect(new Date(op.steps[0].output?.waitingUntil as string).getTime()).toBe(now + REDIS_DROP_RETRY_MS);
  expect(JSON.stringify(op.steps[0].output)).not.toMatch(/\bnew\b|\bold\b/);

  mockFail = '';
  now += REDIS_DROP_RETRY_MS;
  await sweep();
  op = (await getOperation(operationId))!;
  expect(op.status).toBe('succeeded');
  onlyNew();
});

it('does nothing when a newer rotation replaced the password', async () => {
  await rotateSentinelPassword('old', 'new');
  const { operationId } = await scheduleRedisPasswordDrop({ rotationOperationId: 'rot-1', next: 'new' });
  mockSecrets['databases/redis'] = { 'redis-password': 'newer' };
  now += REDIS_DROP_DELAY_MS;
  mockCommands.length = 0;
  await sweep();
  const op = (await getOperation(operationId))!;
  expect(op.status).toBe('succeeded');
  expect(op.steps[0].output?.dropped).toBe(false);
  expect(mockCommands).toHaveLength(0);
  expect(oldValid()).toBe(true);
});

it('does nothing while a newer rotation is pending', async () => {
  await rotateSentinelPassword('old', 'new');
  const { operationId } = await scheduleRedisPasswordDrop({ rotationOperationId: 'rot-1', next: 'new' });
  mockSecrets['platform/platform-rotate-pending'] = { REDIS_PASSWORD_OLD: 'new', REDIS_PASSWORD_NEW: 'newer' };
  now += REDIS_DROP_DELAY_MS;
  await sweep();
  expect((await getOperation(operationId))!.status).toBe('succeeded');
  expect(oldValid()).toBe(true);
});

it('gives up after the retry budget and leaves both passwords working', async () => {
  await rotateSentinelPassword('old', 'new');
  const { operationId } = await scheduleRedisPasswordDrop({ rotationOperationId: 'rot-1', next: 'new' });
  mockNodes.get('redis-node-2.redis-headless:6379')!.passwords = new Set(['old']);
  now += REDIS_DROP_DELAY_MS;
  for (let i = 0; i < REDIS_DROP_MAX_TRIES; i++) {
    await sweep();
    now += REDIS_DROP_RETRY_MS;
  }
  const op = (await getOperation(operationId))!;
  expect(op.status).toBe('failed');
  expect(op.error).toContain('gave up');
  expect(mockNodes.get('redis-node-0.redis-headless:6379')!.passwords).toEqual(new Set(['old', 'new']));
});
