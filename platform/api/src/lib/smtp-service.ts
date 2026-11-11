import nodemailer from 'nodemailer';

export interface SmtpOptions {
  provider: 'custom' | 'ses' | 'sendgrid' | 'mailgun';
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  apiKey?: string;
  fromEmail: string;
  fromName?: string;
}

/** Default bound for every SMTP phase (nodemailer's own connect default is 2 minutes). */
export const DEFAULT_SMTP_TIMEOUT_MS = 15_000;

export interface SendMailOptions {
  /**
   * Upper bound for connect, greeting and socket inactivity, and for the whole send.
   * Alert e-mail passes ALERTING_DELIVERY_TIMEOUT_MS so an unreachable server fails
   * fast (and is retried with backoff) instead of holding the dispatcher.
   */
  timeoutMs?: number;
}

/** nodemailer timeout options, each bounded by `timeoutMs`. */
export function smtpTimeouts(timeoutMs: number = DEFAULT_SMTP_TIMEOUT_MS) {
  const ms = Math.max(500, Math.floor(timeoutMs));
  return { connectionTimeout: ms, greetingTimeout: ms, socketTimeout: ms, dnsTimeout: ms };
}

export function transportOptions(opts: SmtpOptions, timeoutMs: number = DEFAULT_SMTP_TIMEOUT_MS): Record<string, any> {
  const t = smtpTimeouts(timeoutMs);
  switch (opts.provider) {
    case 'sendgrid':
      return { host: 'smtp.sendgrid.net', port: 587, auth: { user: 'apikey', pass: opts.apiKey }, ...t };
    case 'mailgun':
      return { host: 'smtp.mailgun.org', port: 587, auth: { user: opts.username, pass: opts.apiKey }, ...t };
    case 'ses':
      return { host: `email-smtp.${opts.host || 'us-east-1'}.amazonaws.com`, port: 587, auth: { user: opts.username, pass: opts.password }, ...t };
    default:
      return {
        host: opts.host!,
        port: opts.port || 587,
        secure: opts.secure ?? false,
        auth: opts.username ? { user: opts.username, pass: opts.password } : undefined,
        ...t,
      };
  }
}

export class SmtpTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(ms: number) {
    super(`SMTP send timed out after ${ms} ms`);
    this.name = 'SmtpTimeoutError';
  }
}

export async function sendMail(
  opts: SmtpOptions,
  to: string | string[],
  subject: string,
  html: string,
  options: SendMailOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS;
  const transport = nodemailer.createTransport(transportOptions(opts, timeoutMs) as any);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([
      transport.sendMail({
        from: `"${opts.fromName || 'Platform'}" <${opts.fromEmail}>`,
        to: Array.isArray(to) ? to.join(', ') : to,
        subject,
        html,
      }),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try { transport.close(); } catch { /* already closed */ }
  }
}

export async function testSmtpConnection(opts: SmtpOptions, testTo: string): Promise<{ success: boolean; error?: string }> {
  try {
    await sendMail(opts, testTo, 'Platform — SMTP Test', `
      <div style="font-family:sans-serif;max-width:600px;margin:40px auto;">
        <h2 style="color:#7c3aed;">✅ SMTP Configuration Working</h2>
        <p>Your SMTP configuration has been verified successfully. Platform will use this to send deployment alerts and notifications.</p>
        <hr style="border:1px solid #e2e8f0;"/>
        <p style="color:#64748b;font-size:12px;">Platform — Internal Developer Platform</p>
      </div>
    `);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export function buildDeploymentSuccessEmail(opts: { projectName: string; environment: string; version: string; url: string; commitSha: string; deployedBy: string }): string {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:40px auto;background:#0f172a;color:#f8fafc;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#7c3aed,#2563eb);padding:24px;">
        <h1 style="margin:0;font-size:1.5rem;">✅ Deployment Successful</h1>
        <p style="margin:4px 0 0;opacity:0.8;">${opts.projectName} — ${opts.environment.toUpperCase()}</p>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#94a3b8;">Version</td><td style="color:#f8fafc;font-weight:600;">${opts.version}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Environment</td><td style="color:#10b981;font-weight:600;">${opts.environment}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Commit</td><td style="color:#f8fafc;font-family:monospace;">${opts.commitSha.substring(0, 7)}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Deployed By</td><td style="color:#f8fafc;">${opts.deployedBy}</td></tr>
        </table>
        <a href="${opts.url}" style="display:inline-block;margin-top:24px;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">View Live ↗</a>
      </div>
    </div>`;
}

export function buildDeploymentFailedEmail(opts: { projectName: string; environment: string; version: string; error: string; deployedBy: string }): string {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:40px auto;background:#0f172a;color:#f8fafc;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#dc2626,#b91c1c);padding:24px;">
        <h1 style="margin:0;font-size:1.5rem;">❌ Deployment Failed</h1>
        <p style="margin:4px 0 0;opacity:0.8;">${opts.projectName} — ${opts.environment.toUpperCase()}</p>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#94a3b8;">Version</td><td style="color:#f8fafc;font-weight:600;">${opts.version}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Environment</td><td style="color:#ef4444;font-weight:600;">${opts.environment}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Deployed By</td><td style="color:#f8fafc;">${opts.deployedBy}</td></tr>
        </table>
        <div style="margin-top:20px;background:#1e293b;border-radius:8px;padding:16px;">
          <p style="margin:0 0 8px;color:#94a3b8;font-size:12px;text-transform:uppercase;font-weight:600;">Error Details</p>
          <pre style="margin:0;font-family:monospace;font-size:13px;color:#fca5a5;white-space:pre-wrap;">${opts.error}</pre>
        </div>
      </div>
    </div>`;
}

export function buildBackupEmail(opts: { projectName: string; dbName: string; environment: string; fileSize: number; provider: string; status: 'completed' | 'failed'; error?: string }): string {
  const icon = opts.status === 'completed' ? '💾' : '⚠️';
  const color = opts.status === 'completed' ? '#10b981' : '#f59e0b';
  const sizeKb = Math.round(opts.fileSize / 1024);
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:40px auto;background:#0f172a;color:#f8fafc;border-radius:12px;overflow:hidden;">
      <div style="background:${color};padding:24px;">
        <h1 style="margin:0;font-size:1.5rem;color:#fff;">${icon} Database Backup ${opts.status === 'completed' ? 'Completed' : 'Failed'}</h1>
        <p style="margin:4px 0 0;opacity:0.85;color:#fff;">${opts.projectName} — ${opts.environment}</p>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#94a3b8;">Database</td><td style="color:#f8fafc;font-family:monospace;">${opts.dbName}</td></tr>
          <tr><td style="padding:8px 0;color:#94a3b8;">Provider</td><td style="color:#f8fafc;">${opts.provider}</td></tr>
          ${opts.status === 'completed' ? `<tr><td style="padding:8px 0;color:#94a3b8;">File Size</td><td style="color:#f8fafc;">${sizeKb} KB</td></tr>` : ''}
          ${opts.error ? `<tr><td style="padding:8px 0;color:#94a3b8;">Error</td><td style="color:#fca5a5;font-family:monospace;font-size:13px;">${opts.error}</td></tr>` : ''}
        </table>
      </div>
    </div>`;
}
