/**
 * Validation for POST /settings/smtp. Only the fields below are read from the request body;
 * everything else (id, createdAt, updatedAt, ...) is server-controlled.
 */
import { SmtpProvider } from '../entities/SmtpConfig';

export interface SmtpConfigInput {
  name: string;
  provider: SmtpProvider;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  password: string | null;
  apiKey: string | null;
  fromEmail: string;
  fromName: string | null;
  isDefault: boolean;
}

const HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const EMAIL = /^[^\s@"<>,;:\\()[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export class SmtpInputError extends Error {}

function optString(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new SmtpInputError(`${field} must be a string`);
  if (v.length > max) throw new SmtpInputError(`${field} must be at most ${max} characters`);
  return v;
}

function optBool(v: unknown, field: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new SmtpInputError(`${field} must be a boolean`);
  return v;
}

export function parseSmtpConfigInput(body: unknown): SmtpConfigInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SmtpInputError('body must be an object');
  const b = body as Record<string, unknown>;

  const name = optString(b.name, 'name', 100)?.trim();
  if (!name) throw new SmtpInputError('name is required');

  const provider = (b.provider ?? SmtpProvider.CUSTOM) as SmtpProvider;
  if (!Object.values(SmtpProvider).includes(provider)) {
    throw new SmtpInputError(`provider must be one of ${Object.values(SmtpProvider).join(', ')}`);
  }

  const fromEmail = optString(b.fromEmail, 'fromEmail', 255)?.trim();
  if (!fromEmail) throw new SmtpInputError('fromEmail is required');
  if (!EMAIL.test(fromEmail)) throw new SmtpInputError('fromEmail must be an e-mail address');

  const fromName = optString(b.fromName, 'fromName', 255);
  if (fromName && /[\r\n"<>]/.test(fromName)) throw new SmtpInputError('fromName must not contain quotes, angle brackets or line breaks');

  let host = optString(b.host, 'host', 255)?.trim() || null;
  if (provider === SmtpProvider.CUSTOM) {
    if (!host) throw new SmtpInputError('host is required for a custom SMTP server');
    if (!HOSTNAME.test(host) && !IPV4.test(host)) throw new SmtpInputError('host must be a hostname or IPv4 address');
  } else if (provider === SmtpProvider.SES) {
    // For SES, `host` holds the AWS region (email-smtp.<region>.amazonaws.com).
    if (host && !AWS_REGION.test(host)) throw new SmtpInputError('host must be an AWS region (for example us-east-1) for SES');
  } else {
    host = null; // fixed endpoint for SendGrid / Mailgun
  }

  let port: number | null = null;
  if (b.port !== undefined && b.port !== null && b.port !== '') {
    const n = Number(b.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new SmtpInputError('port must be an integer 1..65535');
    port = n;
  }

  const secure = optBool(b.secure, 'secure', provider === SmtpProvider.CUSTOM && port === 465);
  const username = optString(b.username, 'username', 255);
  const password = optString(b.password, 'password', 1024);
  const apiKey = optString(b.apiKey, 'apiKey', 1024);
  if ((provider === SmtpProvider.SENDGRID || provider === SmtpProvider.MAILGUN) && !apiKey) {
    throw new SmtpInputError(`apiKey is required for ${provider}`);
  }

  return {
    name,
    provider,
    host,
    port,
    secure,
    username,
    password,
    apiKey,
    fromEmail,
    fromName,
    isDefault: optBool(b.isDefault, 'isDefault', false),
  };
}
