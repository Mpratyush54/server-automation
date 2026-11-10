/**
 * Alert channels (#43): SSRF guard, payload per channel type, webhook HMAC signature,
 * secret handling (encrypted, never returned), delivery errors.
 */
import { assertSafeUrl, guardedLookup, isPrivateAddress, SsrfBlockedError } from '../../../src/lib/alerting-ssrf';
import {
  AlertMessage, ChannelLike, decryptChannelSecrets, DeliveryError, discordPayload, emailContent, encryptChannelSecrets,
  HttpRequest, normalizeChannelInput, pagerDutyPayload, publicChannel, sendToChannel, signWebhook, slackEscape,
  slackPayload, teamsPayload, verifyWebhookSignature, webhookPayload, severityAllowed,
} from '../../../src/lib/alerting-channels';

process.env.SECRETS_ENCRYPTION_KEY = 'test-key-for-alerting-channels';

const publicResolver = async () => [{ address: '93.184.215.14', family: 4 }];
const privateResolver = async () => [{ address: '10.0.0.5', family: 4 }];

const msg = (over: Partial<AlertMessage> = {}): AlertMessage => ({
  event: 'firing', incidentId: 'inc-1', projectId: 'p-1', projectName: 'shop', title: 'High <errors> & @everyone',
  body: 'Value 12 > 5', severity: 'critical', source: 'monitor', dedupeKey: 'monitor:m1', status: 'firing',
  url: 'https://portal.example.test/alerting?projectId=p-1', environment: 'production', labels: { team: 'web' },
  startedAt: '2026-01-01T00:00:00.000Z', ...over,
});

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe', 'ff02::1', 'not-an-ip',
  ])('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['93.184.215.14', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('refuses private, link-local and internal destinations unless explicitly allowed', async () => {
    await expect(assertSafeUrl('https://169.254.169.254/latest/meta-data', {}, publicResolver)).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertSafeUrl('https://hooks.example.test/x', {}, privateResolver)).rejects.toThrow(/private/);
    await expect(assertSafeUrl('http://localhost:3000/', {}, publicResolver)).rejects.toThrow(/internal/);
    await expect(assertSafeUrl('http://platform-api.platform.svc.cluster.local/', {}, publicResolver)).rejects.toThrow(/internal/);
    await expect(assertSafeUrl('https://[::1]/', {}, publicResolver)).rejects.toThrow(/private/);
    await expect(assertSafeUrl('ftp://example.test/', {}, publicResolver)).rejects.toThrow(/http/);
    await expect(assertSafeUrl('http://example.test/', { httpsOnly: true }, publicResolver)).rejects.toThrow(/https/);
    await expect(assertSafeUrl('https://user:pw@example.test/', {}, publicResolver)).rejects.toThrow(/credentials/);
    await expect(assertSafeUrl('https://example.test/', {}, async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow(/resolve/);
    await expect(assertSafeUrl('https://hooks.example.test/x', {}, publicResolver)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl('http://10.0.0.5/hook', { allowPrivate: true }, privateResolver)).resolves.toBeInstanceOf(URL);
  });

  it('connect-time lookup blocks rebinding to a private address', (done) => {
    const fakeLookup: any = (_h: string, _o: any, cb: any) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    guardedLookup(false, fakeLookup)('evil.example.test', {}, (err: any) => {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      guardedLookup(false, ((_h: string, _o: any, cb: any) => cb(null, [{ address: '93.184.215.14', family: 4 }])) as any)('ok.example.test', {}, (e2: any, addr: string) => {
        expect(e2).toBeNull();
        expect(addr).toBe('93.184.215.14');
        done();
      });
    });
  });
});

describe('payloads', () => {
  it('Slack escapes mrkdwn so alert text cannot mention or link', () => {
    expect(slackEscape('<!channel> & <http://x|y>')).toBe('&lt;!channel&gt; &amp; &lt;http://x|y&gt;');
    const p = slackPayload(msg(), '#alerts');
    expect(p).toMatchObject({ channel: '#alerts', text: '[CRITICAL] High &lt;errors&gt; &amp; @everyone' });
    expect(p.attachments[0]).toMatchObject({ color: '#d32f2f', title_link: msg().url });
    expect(slackPayload(msg({ event: 'resolved' })).text).toMatch(/^\[RESOLVED\]/);
  });

  it('PagerDuty Events v2: trigger with payload, resolve/ack with dedup key only', () => {
    const t = pagerDutyPayload(msg(), 'R0UTINGKEY0000000000000000000000') as any;
    expect(t).toMatchObject({ routing_key: 'R0UTINGKEY0000000000000000000000', event_action: 'trigger', dedup_key: 'p-1:monitor:m1', payload: { severity: 'critical', source: 'shop', component: 'monitor' } });
    expect(pagerDutyPayload(msg({ event: 'resolved' }), 'k')).toEqual({ routing_key: 'k', event_action: 'resolve', dedup_key: 'p-1:monitor:m1' });
    expect(pagerDutyPayload(msg({ event: 'acknowledged' }), 'k')).toMatchObject({ event_action: 'acknowledge' });
    expect((pagerDutyPayload(msg({ dedupeKey: 'x'.repeat(400) }), 'k') as any).dedup_key.length).toBeLessThanOrEqual(255);
  });

  it('Teams Adaptive Card and Discord embed (no mentions)', () => {
    const t = teamsPayload(msg()) as any;
    expect(t.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(t.attachments[0].content.actions[0]).toEqual({ type: 'Action.OpenUrl', title: 'Open in portal', url: msg().url });
    const d = discordPayload(msg());
    expect(d.allowed_mentions).toEqual({ parse: [] });
    expect(d.embeds[0]).toMatchObject({ color: 0xd32f2f, url: msg().url });
  });

  it('generic webhook body and HMAC signature (verifiable, replay-bounded)', () => {
    const body = JSON.stringify(webhookPayload(msg(), '2026-01-01T00:00:05.000Z'));
    expect(JSON.parse(body)).toMatchObject({ version: '1', event: 'incident.firing', incident: { dedupeKey: 'monitor:m1', severity: 'critical' } });
    const sig = signWebhook('s3cret-signing-key', body, 1767225605);
    expect(sig).toMatch(/^t=1767225605,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature('s3cret-signing-key', body, sig, 1767225610)).toBe(true);
    expect(verifyWebhookSignature('wrong-key', body, sig, 1767225610)).toBe(false);
    expect(verifyWebhookSignature('s3cret-signing-key', body + ' ', sig, 1767225610)).toBe(false);
    expect(verifyWebhookSignature('s3cret-signing-key', body, sig, 1767225605 + 3600)).toBe(false);
  });

  it('e-mail is HTML-escaped with a single-line subject', () => {
    const e = emailContent(msg({ title: 'a\r\nBcc: x <b>' }));
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.html).toContain('&lt;b&gt;');
  });

  it('severity filter', () => {
    expect(severityAllowed('warning', 'info')).toBe(false);
    expect(severityAllowed('warning', 'critical')).toBe(true);
    expect(severityAllowed(undefined, 'info')).toBe(true);
  });
});

describe('channel secrets', () => {
  it('validates input and generates a webhook signing secret', async () => {
    const r = await normalizeChannelInput('webhook', { secrets: { url: 'https://hooks.example.test/a' } }, {}, { resolve: publicResolver });
    expect(r.generatedSigningSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(r.secrets.signingSecret).toBe(r.generatedSigningSecret);
    await expect(normalizeChannelInput('webhook', { secrets: { url: 'http://10.0.0.5/' } }, {}, { resolve: privateResolver })).rejects.toThrow(/private/);
    await expect(normalizeChannelInput('slack', { secrets: {} })).rejects.toThrow(/webhookUrl/);
    await expect(normalizeChannelInput('slack', { secrets: { botToken: 'xoxb-1' }, config: {} })).rejects.toThrow(/channel/);
    await expect(normalizeChannelInput('pagerduty', { secrets: { routingKey: 'short' } })).rejects.toThrow(/routingKey/);
    await expect(normalizeChannelInput('email', { config: { to: 'a@example.test, b@example.test' } })).resolves.toMatchObject({ config: { to: ['a@example.test', 'b@example.test'] } });
    await expect(normalizeChannelInput('email', { config: { to: 'nope' } })).rejects.toThrow(/e-mail/);
    await expect(normalizeChannelInput('sms', {})).rejects.toThrow(/type/);
  });

  it('an update without secrets keeps the stored ones', async () => {
    const r = await normalizeChannelInput('discord', { secrets: {} }, { webhookUrl: 'https://discord.example.test/api/webhooks/1/x' }, { resolve: publicResolver });
    expect(r.secrets.webhookUrl).toBe('https://discord.example.test/api/webhooks/1/x');
  });

  it('stores secrets encrypted and never exposes them', () => {
    const enc = encryptChannelSecrets({ webhookUrl: 'https://hooks.slack.example.test/T000/B000/SECRETPART' });
    expect(enc).not.toContain('SECRETPART');
    expect(decryptChannelSecrets(enc).webhookUrl).toContain('SECRETPART');
    const view = publicChannel({ id: 'c1', projectId: 'p', name: 'n', type: 'slack', config: {}, secretEnc: enc });
    expect(JSON.stringify(view)).not.toContain('SECRETPART');
    expect(view).toMatchObject({ secretFields: ['webhookUrl'], destination: 'hooks.slack.example.test' });
    expect(view).not.toHaveProperty('secretEnc');
  });
});

describe('sendToChannel', () => {
  const channel = (type: string, secrets: Record<string, string>, config: any = {}): ChannelLike => ({
    id: 'c1', projectId: 'p-1', name: type, type, config, secretEnc: encryptChannelSecrets(secrets), allowPrivateNetwork: false, enabled: true,
  });
  let calls: HttpRequest[];
  const http = (status = 200, data = '') => async (req: HttpRequest) => { calls.push(req); return { status, data }; };
  beforeEach(() => { calls = []; });

  it('posts each type to its destination', async () => {
    const deps = { http: http(), resolve: publicResolver, now: () => new Date('2026-01-01T00:00:10Z') };
    await sendToChannel(channel('slack', { webhookUrl: 'https://hooks.example.test/s' }), msg(), deps);
    await sendToChannel(channel('slack', { botToken: 'xoxb-123' }, { channel: '#ops' }), msg(), { ...deps, http: async (r) => { calls.push(r); return { status: 200, data: '{"ok":true}' }; } });
    await sendToChannel(channel('pagerduty', { routingKey: 'R'.repeat(32) }, { region: 'eu' }), msg(), deps);
    await sendToChannel(channel('teams', { webhookUrl: 'https://teams.example.test/w' }), msg(), deps);
    await sendToChannel(channel('discord', { webhookUrl: 'https://discord.example.test/w' }), msg(), deps);
    await sendToChannel(channel('webhook', { url: 'https://hooks.example.test/w', signingSecret: 'sign-me-please-123' }), msg(), deps);
    expect(calls.map((c) => c.url)).toEqual([
      'https://hooks.example.test/s', 'https://slack.com/api/chat.postMessage', 'https://events.eu.pagerduty.com/v2/enqueue',
      'https://teams.example.test/w', 'https://discord.example.test/w', 'https://hooks.example.test/w',
    ]);
    expect(calls[1].headers.Authorization).toBe('Bearer xoxb-123');
    const wh = calls[5];
    expect(wh.headers['X-Platform-Event']).toBe('incident.firing');
    expect(verifyWebhookSignature('sign-me-please-123', wh.body, wh.headers['X-Platform-Signature'], 1767225610)).toBe(true);
  });

  it('e-mail goes through the injected sender', async () => {
    const sendEmail = jest.fn(async () => {});
    await sendToChannel(channel('email', {}, { to: ['ops@example.test'] }), msg(), { http: http(), sendEmail });
    expect(sendEmail).toHaveBeenCalledWith(['ops@example.test'], expect.stringContaining('[CRITICAL]'), expect.any(String));
  });

  it('classifies failures: 5xx/429 retryable, 4xx and SSRF not', async () => {
    const c = channel('discord', { webhookUrl: 'https://discord.example.test/w' });
    const e500 = await sendToChannel(c, msg(), { http: http(503), resolve: publicResolver }).catch((e) => e);
    expect(e500).toBeInstanceOf(DeliveryError);
    expect(e500.retryable).toBe(true);
    const e404 = await sendToChannel(c, msg(), { http: http(404, 'Unknown Webhook'), resolve: publicResolver }).catch((e) => e);
    expect(e404.retryable).toBe(false);
    const ssrf = await sendToChannel(c, msg(), { http: http(), resolve: privateResolver }).catch((e) => e);
    expect(ssrf).toBeInstanceOf(DeliveryError);
    expect(ssrf.retryable).toBe(false);
    expect(calls).toHaveLength(2);
    const slackApi = await sendToChannel(channel('slack', { botToken: 'xoxb-1' }, { channel: '#x' }), msg(), { http: http(200, '{"ok":false,"error":"channel_not_found"}'), resolve: publicResolver }).catch((e) => e);
    expect(slackApi.message).toMatch(/channel_not_found/);
  });
});
