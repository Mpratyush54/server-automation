/**
 * Notification channels (#43): Slack (incoming webhook or app bot token), PagerDuty Events v2,
 * Microsoft Teams (Workflows webhook, Adaptive Card), Discord, generic webhook (HMAC-SHA256
 * signed) and e-mail (default SMTP config).
 *
 * Secrets (webhook URLs, tokens, routing keys, signing secrets) are stored only encrypted
 * (`secretEnc`, lib/secrets-encryption) and never returned; `publicChannel` lists which secret
 * fields are set and the destination host. Every outbound request goes through the SSRF guard.
 */
import crypto from 'crypto';
import axios from 'axios';
import { encryptValue, decryptValue } from './secrets-encryption';
import { assertSafeUrl, guardedAgents, Resolver, SsrfBlockedError } from './alerting-ssrf';
import { SEVERITY_RANK } from './alerting-rules';

export const CHANNEL_TYPES = ['slack', 'pagerduty', 'teams', 'discord', 'webhook', 'email'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export type AlertMessageEvent = 'firing' | 'resolved' | 'acknowledged' | 'escalation' | 'test';

export interface AlertMessage {
  event: AlertMessageEvent;
  incidentId: string;
  projectId: string;
  projectName?: string;
  title: string;
  body?: string | null;
  severity: string;
  source: string;
  dedupeKey: string;
  status: string;
  /** Absolute link (or path when the domain is unknown). */
  url?: string | null;
  environment?: string | null;
  labels?: Record<string, string>;
  startedAt: string;
  resolvedAt?: string | null;
  escalationStep?: number;
}

export interface ChannelLike {
  id: string;
  projectId: string;
  name: string;
  type: string;
  config: Record<string, any>;
  secretEnc: string | null;
  minSeverity?: string;
  allowPrivateNetwork?: boolean;
  enabled?: boolean;
}

export interface HttpRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  allowPrivate: boolean;
}
export type HttpPost = (req: HttpRequest) => Promise<{ status: number; data?: string }>;

export interface ChannelDeps {
  http: HttpPost;
  resolve?: Resolver;
  sendEmail?: (to: string[], subject: string, html: string) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
}

function key(): string {
  const value = process.env.SECRETS_ENCRYPTION_KEY;
  if (!value) throw new Error('SECRETS_ENCRYPTION_KEY not configured');
  return value;
}

export function encryptChannelSecrets(secrets: Record<string, string>): string {
  return encryptValue(JSON.stringify(secrets), key());
}

export function decryptChannelSecrets(enc: string | null): Record<string, string> {
  if (!enc) return {};
  return JSON.parse(decryptValue(enc, key()));
}

const SECRET_FIELDS: Record<ChannelType, string[]> = {
  slack: ['webhookUrl', 'botToken'],
  pagerduty: ['routingKey'],
  teams: ['webhookUrl'],
  discord: ['webhookUrl'],
  webhook: ['url', 'signingSecret'],
  email: [],
};

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/**
 * Validate a create/update request. `previous` are the stored secrets (an update may omit
 * secrets to keep them). Returns the normalized config + secrets; for a generic webhook
 * without a signing secret one is generated (and returned once to the caller).
 */
export async function normalizeChannelInput(
  type: string,
  input: { config?: any; secrets?: any },
  previous: Record<string, string> = {},
  opts: { allowPrivate?: boolean; resolve?: Resolver } = {},
): Promise<{ config: Record<string, any>; secrets: Record<string, string>; generatedSigningSecret?: string }> {
  if (!CHANNEL_TYPES.includes(type as ChannelType)) throw new Error(`type must be one of ${CHANNEL_TYPES.join(', ')}`);
  const t = type as ChannelType;
  const rawConfig = input.config && typeof input.config === 'object' ? input.config : {};
  const rawSecrets = input.secrets && typeof input.secrets === 'object' ? input.secrets : {};
  const secrets: Record<string, string> = {};
  for (const f of SECRET_FIELDS[t]) {
    const v = rawSecrets[f];
    if (typeof v === 'string' && v.trim()) secrets[f] = v.trim();
    else if (previous[f]) secrets[f] = previous[f];
  }
  const config: Record<string, any> = {};
  const checkUrl = (u: string, httpsOnly: boolean) => assertSafeUrl(u, { allowPrivate: opts.allowPrivate, httpsOnly }, opts.resolve);
  let generatedSigningSecret: string | undefined;
  switch (t) {
    case 'slack':
      if (secrets.botToken) {
        if (!/^xox[bp]-/.test(secrets.botToken)) throw new Error('secrets.botToken must be a Slack bot token (xoxb-...)');
        const channel = String(rawConfig.channel || '').trim();
        if (!/^[#@]?[\w.-]{1,80}$/.test(channel)) throw new Error('config.channel is required for Slack app delivery');
        config.channel = channel;
        delete secrets.webhookUrl;
      } else if (secrets.webhookUrl) {
        await checkUrl(secrets.webhookUrl, true);
      } else {
        throw new Error('Slack needs secrets.webhookUrl (incoming webhook) or secrets.botToken + config.channel (app)');
      }
      break;
    case 'pagerduty':
      if (!secrets.routingKey || !/^[A-Za-z0-9]{20,64}$/.test(secrets.routingKey)) throw new Error('secrets.routingKey must be a PagerDuty Events v2 integration key');
      config.region = rawConfig.region === 'eu' ? 'eu' : 'us';
      break;
    case 'teams':
    case 'discord':
      if (!secrets.webhookUrl) throw new Error('secrets.webhookUrl is required');
      await checkUrl(secrets.webhookUrl, true);
      break;
    case 'webhook':
      if (!secrets.url) throw new Error('secrets.url is required');
      await checkUrl(secrets.url, false);
      if (!secrets.signingSecret) {
        generatedSigningSecret = crypto.randomBytes(32).toString('hex');
        secrets.signingSecret = generatedSigningSecret;
      } else if (secrets.signingSecret.length < 16) {
        throw new Error('secrets.signingSecret must be at least 16 characters');
      }
      break;
    case 'email': {
      const to = (Array.isArray(rawConfig.to) ? rawConfig.to : String(rawConfig.to || '').split(','))
        .map((s: any) => String(s).trim()).filter(Boolean);
      if (!to.length || to.length > 20 || !to.every((e: string) => EMAIL.test(e))) throw new Error('config.to must be 1..20 e-mail addresses');
      config.to = to;
      break;
    }
  }
  return { config, secrets, generatedSigningSecret };
}

function destinationHost(type: string, secrets: Record<string, string>, config: Record<string, any>): string | null {
  const u = secrets.webhookUrl || secrets.url;
  if (u) {
    try { return new URL(u).host; } catch { return null; }
  }
  if (type === 'slack' && secrets.botToken) return 'slack.com';
  if (type === 'pagerduty') return config.region === 'eu' ? 'events.eu.pagerduty.com' : 'events.pagerduty.com';
  return null;
}

/** API view of a channel: never contains secret values. */
export function publicChannel(c: ChannelLike & Record<string, any>) {
  let secrets: Record<string, string> = {};
  let secretError: string | undefined;
  try {
    secrets = decryptChannelSecrets(c.secretEnc);
  } catch {
    secretError = 'stored secrets cannot be decrypted (encryption key changed?)';
  }
  const { secretEnc, ...rest } = c;
  return {
    ...rest,
    secretFields: Object.keys(secrets).sort(),
    destination: destinationHost(c.type, secrets, c.config || {}),
    ...(secretError ? { secretError } : {}),
  };
}

export function severityAllowed(channelMin: string | undefined, severity: string): boolean {
  return (SEVERITY_RANK[severity] || 0) >= (SEVERITY_RANK[channelMin || 'info'] || 1);
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const COLORS: Record<string, string> = { critical: '#d32f2f', warning: '#f9a825', info: '#1976d2', resolved: '#2e7d32' };

function headline(m: AlertMessage): string {
  switch (m.event) {
    case 'resolved': return `[RESOLVED] ${m.title}`;
    case 'acknowledged': return `[ACK] ${m.title}`;
    case 'escalation': return `[ESCALATED ${m.severity.toUpperCase()}] ${m.title}`;
    case 'test': return `[TEST] ${m.title}`;
    default: return `[${m.severity.toUpperCase()}] ${m.title}`;
  }
}

function color(m: AlertMessage): string {
  return m.event === 'resolved' ? COLORS.resolved : COLORS[m.severity] || COLORS.info;
}

function clip(s: string | null | undefined, n: number): string {
  const v = String(s || '');
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

/** Slack mrkdwn: neutralise &, <, > so alert text cannot inject mentions or links. */
export function slackEscape(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function facts(m: AlertMessage): { name: string; value: string }[] {
  const out = [
    { name: 'Project', value: m.projectName || m.projectId },
    { name: 'Severity', value: m.severity },
    { name: 'Source', value: m.source },
    { name: 'Status', value: m.status },
  ];
  if (m.environment) out.push({ name: 'Environment', value: m.environment });
  return out;
}

export function slackPayload(m: AlertMessage, channel?: string) {
  const text = slackEscape(headline(m));
  return {
    ...(channel ? { channel } : {}),
    text,
    attachments: [{
      color: color(m),
      title: slackEscape(clip(m.title, 250)),
      ...(m.url ? { title_link: m.url } : {}),
      text: slackEscape(clip(m.body, 2000)),
      fields: facts(m).map((f) => ({ title: f.name, value: slackEscape(f.value), short: true })),
      footer: `dedupe ${slackEscape(m.dedupeKey)}`,
      ts: Math.floor(new Date(m.startedAt).getTime() / 1000),
    }],
  };
}

export function pagerDutyDedupKey(m: Pick<AlertMessage, 'projectId' | 'dedupeKey'>): string {
  const k = `${m.projectId}:${m.dedupeKey}`;
  return k.length <= 255 ? k : `${m.projectId}:${crypto.createHash('sha256').update(m.dedupeKey).digest('hex')}`;
}

export function pagerDutyPayload(m: AlertMessage, routingKey: string) {
  const action = m.event === 'resolved' ? 'resolve' : m.event === 'acknowledged' ? 'acknowledge' : 'trigger';
  const base = { routing_key: routingKey, event_action: action, dedup_key: pagerDutyDedupKey(m) };
  if (action !== 'trigger') return base;
  return {
    ...base,
    payload: {
      summary: clip(headline(m), 1024),
      source: m.projectName || m.projectId,
      severity: m.severity === 'critical' ? 'critical' : m.severity === 'warning' ? 'warning' : 'info',
      timestamp: m.startedAt,
      component: m.source,
      group: m.environment || undefined,
      custom_details: { body: clip(m.body, 4000), labels: m.labels || {}, incidentId: m.incidentId },
    },
    client: 'Platform alerting',
    ...(m.url ? { links: [{ href: m.url, text: 'Open in portal' }] } : {}),
  };
}

/** Adaptive Card text colour: info (and tests) use the neutral accent, not Warning. */
export function teamsColor(m: Pick<AlertMessage, 'event' | 'severity'>): 'Good' | 'Attention' | 'Warning' | 'Accent' {
  if (m.event === 'resolved') return 'Good';
  if (m.severity === 'critical') return 'Attention';
  if (m.severity === 'warning') return 'Warning';
  return 'Accent';
}

export function teamsPayload(m: AlertMessage) {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', size: 'Medium', weight: 'Bolder', wrap: true, text: clip(headline(m), 300), color: teamsColor(m) },
          ...(m.body ? [{ type: 'TextBlock', wrap: true, text: clip(m.body, 2000) }] : []),
          { type: 'FactSet', facts: facts(m).map((f) => ({ title: f.name, value: f.value })) },
        ],
        ...(m.url ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in portal', url: m.url }] } : {}),
      },
    }],
  };
}

export function discordPayload(m: AlertMessage) {
  return {
    username: 'Platform alerts',
    // Never ping @everyone / roles / users from alert text.
    allowed_mentions: { parse: [] as string[] },
    embeds: [{
      title: clip(headline(m), 256),
      ...(m.url ? { url: m.url } : {}),
      description: clip(m.body, 4000),
      color: parseInt(color(m).slice(1), 16),
      fields: facts(m).map((f) => ({ name: f.name, value: clip(f.value, 1024), inline: true })),
      timestamp: m.startedAt,
      footer: { text: clip(`dedupe ${m.dedupeKey}`, 2048) },
    }],
  };
}

export function webhookPayload(m: AlertMessage, sentAt: string) {
  return {
    version: '1',
    event: `incident.${m.event}`,
    sentAt,
    incident: {
      id: m.incidentId,
      projectId: m.projectId,
      projectName: m.projectName,
      status: m.status,
      severity: m.severity,
      source: m.source,
      dedupeKey: m.dedupeKey,
      title: m.title,
      body: m.body || null,
      url: m.url || null,
      environment: m.environment || null,
      labels: m.labels || {},
      startedAt: m.startedAt,
      resolvedAt: m.resolvedAt || null,
      escalationStep: m.escalationStep ?? 0,
    },
  };
}

/**
 * Generic webhook signature: `X-Platform-Signature: t=<unix seconds>,v1=<hex>` where
 * hex = HMAC-SHA256(signingSecret, "<t>.<raw body>"). Receivers recompute it, compare in
 * constant time and reject old timestamps (replay).
 */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhookSignature(secret: string, body: string, header: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds || !parts.v1) return false;
  const expected = signWebhook(secret, body, t).split('v1=')[1];
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(parts.v1), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function emailContent(m: AlertMessage): { subject: string; html: string } {
  const rows = facts(m).map((f) => `<tr><td style="padding:2px 8px"><b>${escapeHtml(f.name)}</b></td><td>${escapeHtml(f.value)}</td></tr>`).join('');
  const link = m.url && /^https?:\/\//.test(m.url) ? `<p><a href="${escapeHtml(m.url)}">Open in portal</a></p>` : '';
  return {
    subject: clip(headline(m).replace(/[\r\n]+/g, ' '), 200),
    html: `<h2 style="color:${color(m)}">${escapeHtml(headline(m))}</h2><p>${escapeHtml(m.body || '')}</p><table>${rows}</table>${link}`,
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Default transport: axios with SSRF-guarded agents, no redirects, bounded response. */
export const axiosHttpPost: HttpPost = async (req) => {
  const agents = guardedAgents(req.allowPrivate);
  const res = await axios.post(req.url, req.body, {
    headers: req.headers,
    timeout: req.timeoutMs,
    maxRedirects: 0,
    maxContentLength: 64 * 1024,
    responseType: 'text',
    transformResponse: (d) => d,
    validateStatus: () => true,
    proxy: false,
    ...agents,
  });
  return { status: res.status, data: typeof res.data === 'string' ? res.data.slice(0, 2000) : '' };
};

export class DeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'DeliveryError';
  }
}

async function post(deps: ChannelDeps, url: string, payload: unknown, allowPrivate: boolean, httpsOnly: boolean, extraHeaders: Record<string, string> = {}, rawBody?: string) {
  await assertSafeUrl(url, { allowPrivate, httpsOnly }, deps.resolve);
  const body = rawBody ?? JSON.stringify(payload);
  const res = await deps.http({
    url,
    body,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'platform-alerting/1', ...extraHeaders },
    timeoutMs: deps.timeoutMs ?? 10_000,
    allowPrivate,
  });
  if (res.status < 200 || res.status >= 300) {
    // 4xx (except 408/429) will not succeed on retry: bad URL, revoked token.
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new DeliveryError(`HTTP ${res.status}${res.data ? `: ${clip(res.data, 200)}` : ''}`, retryable);
  }
  return res;
}

/** Send one message to one channel. Throws DeliveryError / SsrfBlockedError on failure. */
export async function sendToChannel(channel: ChannelLike, m: AlertMessage, deps: ChannelDeps): Promise<void> {
  const secrets = decryptChannelSecrets(channel.secretEnc);
  const allowPrivate = !!channel.allowPrivateNetwork;
  const config = channel.config || {};
  try {
    switch (channel.type) {
      case 'slack': {
        if (secrets.botToken) {
          const res = await post(deps, 'https://slack.com/api/chat.postMessage', slackPayload(m, config.channel), false, true, { Authorization: `Bearer ${secrets.botToken}` });
          let ok = true;
          try { ok = JSON.parse(res.data || '{}').ok !== false; } catch { /* non-JSON: treat as ok */ }
          if (!ok) throw new DeliveryError(`Slack API error: ${clip(res.data, 200)}`, false);
          return;
        }
        await post(deps, secrets.webhookUrl, slackPayload(m), allowPrivate, true);
        return;
      }
      case 'pagerduty': {
        const host = config.region === 'eu' ? 'events.eu.pagerduty.com' : 'events.pagerduty.com';
        await post(deps, `https://${host}/v2/enqueue`, pagerDutyPayload(m, secrets.routingKey), false, true);
        return;
      }
      case 'teams':
        await post(deps, secrets.webhookUrl, teamsPayload(m), allowPrivate, true);
        return;
      case 'discord':
        await post(deps, secrets.webhookUrl, discordPayload(m), allowPrivate, true);
        return;
      case 'webhook': {
        const now = (deps.now || (() => new Date()))();
        const body = JSON.stringify(webhookPayload(m, now.toISOString()));
        const ts = Math.floor(now.getTime() / 1000);
        await post(deps, secrets.url, null, allowPrivate, false, {
          'X-Platform-Event': `incident.${m.event}`,
          'X-Platform-Delivery': crypto.randomUUID(),
          'X-Platform-Signature': signWebhook(secrets.signingSecret, body, ts),
        }, body);
        return;
      }
      case 'email': {
        if (!deps.sendEmail) throw new DeliveryError('E-mail delivery is not configured', false);
        const { subject, html } = emailContent(m);
        await deps.sendEmail(config.to || [], subject, html);
        return;
      }
      default:
        throw new DeliveryError(`Unknown channel type ${channel.type}`, false);
    }
  } catch (err: any) {
    if (err instanceof DeliveryError) throw err;
    if (err instanceof SsrfBlockedError) throw new DeliveryError(err.message, false);
    throw new DeliveryError(err?.message || String(err), true);
  }
}
