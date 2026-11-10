import {
  builtinRulesPublic,
  luhnValid,
  scrubText,
  scrubValue,
  validateScrubRule,
} from '../../../src/lib/pii-scrub';

/** Fixture lines seeded with PII — each must be redacted by scrubText. */
const FIXTURES: Array<{ name: string; input: string; mustInclude: string[]; mustNotInclude: string[] }> = [
  {
    name: 'email in log line',
    input: 'user signed in as alice.smith@example.org from dashboard',
    mustInclude: ['[EMAIL]'],
    mustNotInclude: ['alice.smith@example.org'],
  },
  {
    name: 'bearer token',
    input: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb',
    mustInclude: ['[REDACTED]'],
    mustNotInclude: ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb'],
  },
  {
    name: 'sdk live token',
    input: 'token=sdk_live_abcdefghijklmnopqrstuvwxyz012345',
    mustInclude: ['[REDACTED]'],
    mustNotInclude: ['abcdefghijklmnopqrstuvwxyz012345'],
  },
  {
    name: 'visa-like card (Luhn-valid)',
    // 4111111111111111 is a well-known test PAN
    input: 'paid with 4111-1111-1111-1111 today',
    mustInclude: ['[CARD]'],
    mustNotInclude: ['4111-1111-1111-1111'],
  },
  {
    name: 'ipv4',
    input: 'client 203.0.113.42 timed out',
    mustInclude: ['[IP]'],
    mustNotInclude: ['203.0.113.42'],
  },
  {
    name: 'password field',
    input: 'password=super-secret-value',
    mustInclude: ['[REDACTED]'],
    mustNotInclude: ['super-secret-value'],
  },
];

describe('luhnValid', () => {
  it('accepts known test PANs and rejects garbage', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111-1111-1111-1111')).toBe(true);
    expect(luhnValid('1234567890123456')).toBe(false);
    expect(luhnValid('123')).toBe(false);
  });
});

describe('scrubText fixtures', () => {
  for (const fix of FIXTURES) {
    it(fix.name, () => {
      const out = scrubText(fix.input);
      for (const s of fix.mustInclude) expect(out).toContain(s);
      for (const s of fix.mustNotInclude) expect(out).not.toContain(s);
    });
  }

  it('leaves non-Luhn digit runs alone', () => {
    const out = scrubText('order id 1234-5678-9012-3456 stays');
    expect(out).toContain('1234-5678-9012-3456');
    expect(out).not.toContain('[CARD]');
  });

  it('can disable IP scrubbing', () => {
    const out = scrubText('client 203.0.113.42', { scrubIps: false });
    expect(out).toContain('203.0.113.42');
  });

  it('applies project extra rules after built-ins', () => {
    const out = scrubText('trace cust_ABC123 end', {
      extraRules: [{ id: 'cust', pattern: 'cust_[A-Z0-9]+', replacement: '[CUST]', flags: 'g' }],
    });
    expect(out).toContain('[CUST]');
    expect(out).not.toContain('cust_ABC123');
  });
});

describe('scrubValue', () => {
  it('deep-scrubs nested objects and arrays', () => {
    const out = scrubValue({
      msg: 'mail me at bob@example.com',
      nested: { ip: '198.51.100.10', items: ['Bearer abcdefghijklmnop'] },
    });
    expect(out.msg).toContain('[EMAIL]');
    expect(out.nested.ip).toBe('[IP]');
    expect(out.nested.items[0]).toMatch(/REDACTED/);
  });
});

describe('validateScrubRule', () => {
  it('accepts a well-formed rule', () => {
    const r = validateScrubRule({ id: 'phone', pattern: '\\b\\d{3}-\\d{4}\\b', replacement: '[PHONE]' });
    expect(r.ok).toBe(true);
  });
  it('rejects bad ids and patterns', () => {
    expect(validateScrubRule({ id: '1bad', pattern: 'a' }).ok).toBe(false);
    expect(validateScrubRule({ id: 'ok', pattern: '(unterminated' }).ok).toBe(false);
  });
});

describe('builtinRulesPublic', () => {
  it('exposes the catalogue used by the portal', () => {
    const rules = builtinRulesPublic(true);
    expect(rules.map((r) => r.id).sort()).toEqual(['card', 'email', 'ipv4', 'ipv6', 'token'].sort());
  });
});
