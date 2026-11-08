import { getJwtSecret, validateSecurityEnv, resolveCorsOrigins } from '../../../src/config/security-env';

const STRONG = 'x'.repeat(48);

describe('validateSecurityEnv (H10)', () => {
  it('refuses a missing JWT_SECRET', () => {
    expect(validateSecurityEnv({} as any).join('\n')).toMatch(/JWT_SECRET is not set/);
  });

  it('refuses the published default JWT_SECRET', () => {
    const problems = validateSecurityEnv({ JWT_SECRET: 'plat-super-secret-key' } as any);
    expect(problems.join('\n')).toMatch(/published default/);
  });

  it('refuses a JWT_SECRET shorter than 32 characters', () => {
    expect(validateSecurityEnv({ JWT_SECRET: 'a'.repeat(31) } as any).join('\n')).toMatch(/at least 32/);
  });

  it('accepts a strong JWT_SECRET', () => {
    expect(validateSecurityEnv({ JWT_SECRET: STRONG } as any)).toEqual([]);
  });

  it('refuses the published default ADMIN_PASSWORD and encryption keys', () => {
    const problems = validateSecurityEnv({
      JWT_SECRET: STRONG, ADMIN_PASSWORD: 'Admin@123', SECRETS_ENCRYPTION_KEY: 'plat-db-creds-fallback',
    } as any);
    expect(problems).toHaveLength(2);
  });
});

describe('getJwtSecret', () => {
  it('throws when JWT_SECRET is missing (no hardcoded fallback)', () => {
    expect(() => getJwtSecret({} as any)).toThrow(/not configured/);
  });

  it('throws on the published default outside tests', () => {
    expect(() => getJwtSecret({ JWT_SECRET: 'plat-super-secret-key', NODE_ENV: 'production' } as any)).toThrow();
  });

  it('returns the configured secret', () => {
    expect(getJwtSecret({ JWT_SECRET: STRONG, NODE_ENV: 'production' } as any)).toBe(STRONG);
  });
});

describe('resolveCorsOrigins (L1)', () => {
  it('uses CORS_ORIGINS when set and adds localhost:4200 outside production', () => {
    expect(resolveCorsOrigins({ CORS_ORIGINS: 'https://a.example.com/, https://b.example.com' } as any).sort()).toEqual(
      ['http://localhost:4200', 'https://a.example.com', 'https://b.example.com'],
    );
  });

  it('derives from DOMAIN and omits localhost in production', () => {
    expect(resolveCorsOrigins({ DOMAIN: 'plat.example.com', NODE_ENV: 'production' } as any).sort()).toEqual(
      ['https://plat.example.com', 'https://www.plat.example.com'],
    );
  });

  it('never allows wildcard by default', () => {
    expect(resolveCorsOrigins({ NODE_ENV: 'production' } as any)).toEqual([]);
  });
});
