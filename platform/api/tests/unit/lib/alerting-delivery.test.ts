/**
 * Alert delivery hardening: bounded concurrency (a hanging channel / SMTP server does not
 * block other deliveries), SMTP timeouts bounded by the delivery timeout, SMTP error
 * classification and retry/backoff semantics.
 */
import { MemoryRepo } from '../../helpers/memory-repo';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}
jest.mock('../../../src/config/database', () => ({
  getDb: async () => ({ getRepository: (entity: any) => mockRepo(typeof entity === 'string' ? entity : entity?.name) }),
}));
jest.mock('../../../src/lib/notify', () => ({ notifyUser: jest.fn(async () => {}) }));
const mockSendMail = jest.fn();
jest.mock('../../../src/lib/smtp-service', () => ({ sendMail: (...a: any[]) => mockSendMail(...a) }));

import {
  processAlertEvent, dispatchDeliveries, retryDelayMs, mapWithConcurrency, classifySmtpError, defaultChannelDeps,
} from '../../../src/lib/alerting-engine';
import { encryptChannelSecrets, DeliveryError, HttpRequest } from '../../../src/lib/alerting-channels';
import { alertingSettings } from '../../../src/lib/alerting-config';

process.env.SECRETS_ENCRYPTION_KEY = 'test-key-for-alerting-delivery';

const PID = '11111111-1111-4111-8111-111111111111';
const T0 = new Date('2026-03-01T10:00:00Z');
const publicResolver = async () => [{ address: '93.184.215.14', family: 4 }];

function channel(id: string, type: string, secrets: Record<string, string>, extra: any = {}) {
  mockRepo('AlertChannel').rows.push({
    id, projectId: PID, name: type, type, config: {}, secretEnc: Object.keys(secrets).length ? encryptChannelSecrets(secrets) : null,
    minSeverity: 'info', allowPrivateNetwork: false, enabled: true, lastDeliveryAt: null, lastError: null, ...extra,
  });
}

const deliveries = () => mockRepo('AlertDelivery').rows;

beforeEach(() => {
  for (const k of Object.keys(mockRepos)) delete mockRepos[k];
  mockRepo('Project').rows.push({ id: PID, name: 'shop' });
  mockSendMail.mockReset();
});

describe('mapWithConcurrency', () => {
  it('never runs more than the limit at once and processes every item', async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      done.push(n);
      inFlight--;
    });
    expect(peak).toBe(4);
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('dispatcher concurrency', () => {
  it('a hanging e-mail delivery does not block Slack / webhook deliveries', async () => {
    channel('22222222-0000-4000-8000-000000000001', 'email', {}, { config: { to: ['ops@example.test'] } });
    channel('22222222-0000-4000-8000-000000000002', 'slack', { webhookUrl: 'https://hooks.example.test/s' });
    channel('22222222-0000-4000-8000-000000000003', 'webhook', { url: 'https://receiver.example.test/h', signingSecret: 'sign-me-please-123' });
    await processAlertEvent({ projectId: PID, source: 'monitor', severity: 'critical', dedupeKey: 'm1', title: 'Down' }, T0);
    expect(deliveries()).toHaveLength(3);

    let releaseEmail!: () => void;
    const sent: string[] = [];
    const deps = {
      resolve: publicResolver,
      http: async (r: HttpRequest) => { sent.push(r.url); return { status: 200, data: '' }; },
      sendEmail: () => new Promise<void>((resolve) => { releaseEmail = resolve; }),
    };
    const run = dispatchDeliveries(T0, deps, 50, 4);
    // Slack + webhook complete while the e-mail is still hanging.
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((r) => setImmediate(r));
    expect(sent.sort()).toEqual(['https://hooks.example.test/s', 'https://receiver.example.test/h']);
    expect(deliveries().filter((d) => d.status === 'sent')).toHaveLength(2);
    releaseEmail();
    expect(await run).toMatchObject({ sent: 3, failed: 0, retried: 0 });
  });

  it('serial dispatch (concurrency 1) still processes every due delivery', async () => {
    channel('22222222-0000-4000-8000-000000000002', 'slack', { webhookUrl: 'https://hooks.example.test/s' });
    channel('22222222-0000-4000-8000-000000000003', 'discord', { webhookUrl: 'https://discord.example.test/api/webhooks/1/x' });
    await processAlertEvent({ projectId: PID, source: 'monitor', severity: 'critical', dedupeKey: 'm1', title: 'Down' }, T0);
    const res = await dispatchDeliveries(T0, { resolve: publicResolver, http: async () => ({ status: 200 }) }, 50, 1);
    expect(res).toMatchObject({ sent: 2 });
  });
});

describe('retry semantics', () => {
  it.each([503, 429])('HTTP %i is retried after 30/60/120/240 s, then failed after 5 attempts', async (code) => {
    channel('22222222-0000-4000-8000-000000000002', 'slack', { webhookUrl: 'https://hooks.example.test/s' });
    await processAlertEvent({ projectId: PID, source: 'monitor', severity: 'critical', dedupeKey: 'm1', title: 'Down' }, T0);
    const deps = { resolve: publicResolver, http: async () => ({ status: code }) };
    const gaps: number[] = [];
    let now = T0;
    for (let i = 0; i < 10 && deliveries()[0].status === 'pending'; i++) {
      await dispatchDeliveries(now, deps);
      const d = deliveries()[0];
      if (d.status === 'pending') {
        gaps.push((new Date(d.nextAttemptAt).getTime() - now.getTime()) / 1000);
        now = new Date(d.nextAttemptAt);
      }
    }
    expect(gaps).toEqual([30, 60, 120, 240]);
    expect(deliveries()[0]).toMatchObject({ status: 'failed', attempts: 5 });
    expect(alertingSettings().maxDeliveryAttempts).toBe(5);
    expect(retryDelayMs(1)).toBe(30_000);
  });

  it('other 4xx fail at once', async () => {
    channel('22222222-0000-4000-8000-000000000002', 'slack', { webhookUrl: 'https://hooks.example.test/s' });
    await processAlertEvent({ projectId: PID, source: 'monitor', severity: 'critical', dedupeKey: 'm1', title: 'Down' }, T0);
    expect(await dispatchDeliveries(T0, { resolve: publicResolver, http: async () => ({ status: 403 }) })).toMatchObject({ failed: 1 });
  });
});

describe('alert e-mail through the default SMTP config', () => {
  it('passes the delivery timeout to sendMail and maps SMTP errors', async () => {
    mockRepo('SmtpConfig').rows.push({ id: 's1', isDefault: true, provider: 'custom', host: 'smtp.example.test', fromEmail: 'a@example.test' });
    mockSendMail.mockResolvedValueOnce(undefined);
    await defaultChannelDeps().sendEmail!(['ops@example.test'], 'subject', '<p>x</p>');
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.test' }), ['ops@example.test'], 'subject', '<p>x</p>', { timeoutMs: alertingSettings().deliveryTimeoutMs });

    mockSendMail.mockRejectedValueOnce(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }));
    await expect(defaultChannelDeps().sendEmail!(['ops@example.test'], 's', 'h')).rejects.toMatchObject({ retryable: true });
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }));
    await expect(defaultChannelDeps().sendEmail!(['ops@example.test'], 's', 'h')).rejects.toMatchObject({ retryable: false });
  });

  it('no default SMTP config is a permanent failure', async () => {
    await expect(defaultChannelDeps().sendEmail!(['ops@example.test'], 's', 'h')).rejects.toBeInstanceOf(DeliveryError);
  });

  it('classifySmtpError', () => {
    expect(classifySmtpError({ code: 'EAUTH', message: 'Invalid login' }).retryable).toBe(false);
    expect(classifySmtpError({ responseCode: 421, message: 'try later' }).retryable).toBe(true);
    expect(classifySmtpError({ code: 'ECONNREFUSED', message: 'refused' }).retryable).toBe(true);
    expect(classifySmtpError({ responseCode: 554, message: 'rejected' }).retryable).toBe(false);
  });
});
