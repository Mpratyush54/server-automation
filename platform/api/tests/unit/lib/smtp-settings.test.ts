/**
 * SMTP settings: credentials encrypted at rest with transparent reads of legacy plaintext
 * rows, input validation / whitelisting.
 */
import {
  decryptSmtpSecret, encryptLegacySmtpSecrets, encryptSmtpSecret, isEncryptedSmtpSecret, publicSmtpConfig, smtpSecretTransformer,
} from '../../../src/lib/smtp-secrets';
import { parseSmtpConfigInput } from '../../../src/lib/smtp-input';

process.env.SECRETS_ENCRYPTION_KEY = 'test-key-for-smtp';

describe('SMTP credentials at rest', () => {
  it('encrypts with a marker prefix and decrypts back', () => {
    const enc = encryptSmtpSecret('hunter2-password')!;
    expect(isEncryptedSmtpSecret(enc)).toBe(true);
    expect(enc).not.toContain('hunter2');
    expect(decryptSmtpSecret(enc)).toBe('hunter2-password');
    expect(encryptSmtpSecret(enc)).toBe(enc); // idempotent
    expect(encryptSmtpSecret(null)).toBeNull();
    expect(encryptSmtpSecret('')).toBeNull();
  });

  it('legacy plaintext rows are still readable', () => {
    expect(decryptSmtpSecret('legacy-plain')).toBe('legacy-plain');
    expect(smtpSecretTransformer.from('legacy-plain')).toBe('legacy-plain');
    expect(smtpSecretTransformer.from(null)).toBeNull();
    expect(smtpSecretTransformer.from(smtpSecretTransformer.to('k3y')!)).toBe('k3y');
  });

  it('a value that cannot be decrypted (key changed) reads as null instead of throwing', () => {
    const enc = encryptSmtpSecret('x')!;
    const key = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = 'another-key';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(decryptSmtpSecret(enc)).toBeNull();
    } finally {
      process.env.SECRETS_ENCRYPTION_KEY = key;
      warn.mockRestore();
    }
  });

  it('startup migration re-saves only plaintext values, encrypted', async () => {
    const calls: { sql: string; params?: any[] }[] = [];
    const ds = {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (/^\s*SELECT/.test(sql)) return [{ id: 'a', password: 'plain-pass', api_key: null }, { id: 'b', password: encryptSmtpSecret('p2'), api_key: 'plain-key' }];
        return [];
      },
    };
    expect(await encryptLegacySmtpSecrets(ds as any)).toBe(2);
    const updates = calls.filter((c) => c.sql.startsWith('UPDATE'));
    expect(updates).toHaveLength(2);
    const [pa, ka, ida] = updates[0].params!;
    expect(ida).toBe('a');
    expect(isEncryptedSmtpSecret(pa)).toBe(true);
    expect(decryptSmtpSecret(pa)).toBe('plain-pass');
    expect(ka).toBeNull();
    const [pb, kb] = updates[1].params!;
    expect(decryptSmtpSecret(pb)).toBe('p2');
    expect(decryptSmtpSecret(kb)).toBe('plain-key');
    expect(JSON.stringify(updates.map((u) => u.params))).not.toContain('plain-pass');
  });

  it('migration is a no-op without an encryption key', async () => {
    const key = process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.SECRETS_ENCRYPTION_KEY;
    try {
      const ds = { query: jest.fn() };
      expect(await encryptLegacySmtpSecrets(ds as any)).toBe(0);
      expect(ds.query).not.toHaveBeenCalled();
    } finally {
      process.env.SECRETS_ENCRYPTION_KEY = key;
    }
  });

  it('API shape never contains the secret', () => {
    const out = publicSmtpConfig({ id: 'x', name: 'n', password: 'p@ss', apiKey: null });
    expect(out).toMatchObject({ password: '***', apiKey: null, hasPassword: true, hasApiKey: false });
    expect(JSON.stringify(out)).not.toContain('p@ss');
  });
});

describe('SMTP config input', () => {
  const base = { name: 'Primary', provider: 'custom', host: 'smtp.example.com', port: 587, fromEmail: 'noreply@example.com' };

  it('whitelists fields and applies defaults', () => {
    const out = parseSmtpConfigInput({ ...base, id: 'x', createdAt: 'y', isDefault: true, password: 'p' });
    expect(out).toEqual({
      name: 'Primary', provider: 'custom', host: 'smtp.example.com', port: 587, secure: false, username: null,
      password: 'p', apiKey: null, fromEmail: 'noreply@example.com', fromName: null, isDefault: true,
    });
    expect(parseSmtpConfigInput({ ...base, port: 465 }).secure).toBe(true);
  });

  it('provider-specific rules', () => {
    expect(() => parseSmtpConfigInput({ ...base, provider: 'sendgrid' })).toThrow(/apiKey/);
    expect(parseSmtpConfigInput({ ...base, provider: 'sendgrid', apiKey: 'SG.x' }).host).toBeNull();
    expect(parseSmtpConfigInput({ ...base, provider: 'ses', host: 'eu-west-1' }).host).toBe('eu-west-1');
    expect(() => parseSmtpConfigInput({ ...base, provider: 'ses', host: 'evil.example.com/x' })).toThrow(/region/);
    expect(() => parseSmtpConfigInput({ ...base, provider: 'postmark' })).toThrow(/provider/);
  });

  it('rejects bad values', () => {
    expect(() => parseSmtpConfigInput(null)).toThrow();
    expect(() => parseSmtpConfigInput({ ...base, name: '' })).toThrow(/name/);
    expect(() => parseSmtpConfigInput({ ...base, port: 0 })).toThrow(/port/);
    expect(() => parseSmtpConfigInput({ ...base, port: 1.5 })).toThrow(/port/);
    expect(() => parseSmtpConfigInput({ ...base, host: 'a b' })).toThrow(/host/);
    expect(() => parseSmtpConfigInput({ ...base, secure: 'true' })).toThrow(/secure/);
    expect(() => parseSmtpConfigInput({ ...base, fromEmail: 'x@y.com\r\nBcc: z@w.com' })).toThrow(/fromEmail/);
    expect(() => parseSmtpConfigInput({ ...base, fromName: 'a"b' })).toThrow(/fromName/);
    expect(() => parseSmtpConfigInput({ ...base, password: 'x'.repeat(2000) })).toThrow(/password/);
  });
});
