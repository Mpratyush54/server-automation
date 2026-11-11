import {
  CheckValidationError, decryptCheckSecrets, mergeCheckSecrets, projectIngressHosts, publicCheck, validateCheckInput,
} from '../../../src/lib/synthetic-checks';

beforeAll(() => { process.env.SECRETS_ENCRYPTION_KEY = 'e'.repeat(64); });

const http = (config: any, extra: any = {}) => ({ name: 'Home', type: 'http', config: { url: 'https://example.com/', ...config }, ...extra });
const bad = (body: any, re: RegExp, hosts: string[] = []) => {
  expect(() => validateCheckInput(body, hosts)).toThrow(CheckValidationError);
  expect(() => validateCheckInput(body, hosts)).toThrow(re);
};

describe('check validation', () => {
  it('normalises an HTTP check with defaults', () => {
    const c = validateCheckInput(http({}), []);
    expect(c).toMatchObject({
      name: 'Home', type: 'http', enabled: true, intervalSeconds: 300, timeoutMs: 10_000, locations: ['local'],
      alertPolicy: { enabled: true, failureThreshold: 2, severity: 'critical' },
      config: { url: 'https://example.com/', method: 'GET', headers: {}, assertions: [], followRedirects: true, maxRedirects: 5, statusPage: { visible: true } },
    });
  });

  it('refuses internal / private targets at save time', () => {
    bad(http({ url: 'http://platform-api.platform.svc:3000/api' }), /internal/);
    bad(http({ url: 'http://169.254.169.254/' }), /Private, loopback/);
    bad(http({ url: 'http://localhost/' }), /internal/);
    bad(http({ url: 'https://u:p@example.com/' }), /Credentials/);
    bad({ name: 'm', type: 'multistep', config: { steps: [{ url: 'https://{{host}}/x' }] } }, /host cannot contain variables/);
    bad({ name: 's', type: 'ssl', config: { host: 'kubernetes.default.svc' } }, /internal/);
  });

  it('enforces limits', () => {
    bad(http({}, { intervalSeconds: 10 }), /intervalSeconds must be 60/);
    bad(http({}, { timeoutMs: 120_000 }), /timeoutMs/);
    bad(http({ maxRedirects: 9 }), /maxRedirects/);
    bad(http({ headers: { Host: 'evil' } }), /cannot be set/);
    bad(http({ headers: { 'X-A': 'a\r\nInjected: 1' } }), /single-line/);
    bad(http({ assertions: [{ source: 'body', comparison: 'matches', target: '(a+)+' }] }), /nested/);
    bad(http({ assertions: [{ source: 'json', comparison: 'eq', target: 1 }] }), /property is required/);
    bad(http({}, { locations: ['eu-west'] }), /only \["local"\]/);
    bad({ name: 'b', type: 'browser', intervalSeconds: 60, config: { steps: [{ action: 'goto', url: 'https://e.com' }] } }, /intervalSeconds must be 300/);
    bad({ name: 'b', type: 'browser', intervalSeconds: 420, config: { steps: [{ action: 'goto', url: 'https://e.com' }] } }, /one of 300/);
    bad({ name: 'b', type: 'browser', config: { steps: [{ action: 'click', selector: 'a' }] } }, /must be a goto/);
    bad(http({}, { secrets: { 'bad name': 'x' } }), /invalid name/);
    bad({ ...http({}), type: 'nope' }, /type must be one of/);
  });

  it('type cannot change on update', () => {
    expect(() => validateCheckInput({ ...http({}), type: 'ssl' }, [], { type: 'http' })).toThrow(/cannot be changed/);
  });

  it('validates SSL thresholds', () => {
    expect(validateCheckInput({ name: 's', type: 'ssl', config: { host: 'Example.com' } }, []).config).toMatchObject({ host: 'example.com', port: 443, warnDays: 14, criticalDays: 0 });
    bad({ name: 's', type: 'ssl', config: { host: 'e.com', warnDays: 5, criticalDays: 5 } }, /criticalDays/);
  });

  it('accepts multi-step flows with extraction', () => {
    const c = validateCheckInput({
      name: 'flow', type: 'multistep', timeoutMs: 30_000, config: {
        steps: [
          { name: 'a', method: 'post', url: 'https://api.example.com/login', body: '{}', extract: [{ name: 'tok', source: 'json', property: '$.t' }] },
          { name: 'b', url: 'https://api.example.com/me?t={{tok}}' },
        ],
      },
    }, []);
    expect(c.config.steps[0]).toMatchObject({ method: 'POST', extract: [{ name: 'tok', source: 'json', property: '$.t' }] });
  });
});

describe('secrets', () => {
  it('are encrypted, merged (set / delete) and never exposed', () => {
    const enc = mergeCheckSecrets(null, { TOKEN: 'abc123', OTHER: 'x' });
    expect(enc).not.toContain('abc123');
    expect(decryptCheckSecrets(enc)).toEqual({ TOKEN: 'abc123', OTHER: 'x' });
    const next = mergeCheckSecrets(enc, { OTHER: null, NEW: 'n' });
    expect(decryptCheckSecrets(next)).toEqual({ TOKEN: 'abc123', NEW: 'n' });
    expect(mergeCheckSecrets(enc, undefined)).toBe(enc);
    expect(mergeCheckSecrets(enc, { TOKEN: null, OTHER: null })).toBeNull();
    const view = publicCheck({ id: 'c', secretsEncrypted: next, alertPolicy: {}, locations: [] } as any);
    expect(view).toMatchObject({ secretNames: ['NEW', 'TOKEN'], locations: ['local'] });
    expect(view).not.toHaveProperty('secretsEncrypted');
    expect(JSON.stringify(view)).not.toContain('abc123');
  });
});

it('project ingress hosts: active environment hosts only, never the platform domain', () => {
  expect(projectIngressHosts([
    { domain: 'https://App.Example.com/', isActive: true },
    { domain: 'old.example.com', isActive: false },
    { domain: 'platform.example.com' },
    { domain: null },
  ], 'platform.example.com')).toEqual(['app.example.com']);
});

describe('templates', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SYNTHETIC_TEMPLATES } = require('../../../src/lib/synthetic-templates');
  const smoke = SYNTHETIC_TEMPLATES.find((t: any) => t.id === 'browser-smoke');

  it('browser-smoke is target-agnostic: no heading/text assumptions, waits for the body', () => {
    const steps = smoke.check.config.steps;
    expect(steps[0]).toEqual({ action: 'goto', url: '' });
    expect(steps.some((s: any) => s.selector === 'h1' || s.action === 'assert_text')).toBe(false);
    expect(steps).toContainEqual({ action: 'wait_for', selector: 'body' });
    expect(smoke.requiredFields).toEqual(['config.steps[0].url']);
  });

  it('browser-smoke cannot be saved until the user enters a URL, then validates', () => {
    const body = { name: smoke.name, ...smoke.check };
    bad(body, /steps\[0\]\.url is required/);
    const withUrl = { ...body, config: { steps: [{ action: 'goto', url: 'https://shop.customer.example/' }, ...body.config.steps.slice(1)] } };
    expect(validateCheckInput(withUrl, []).config.steps).toHaveLength(2);
  });

  it('every other template validates as shipped', () => {
    for (const t of SYNTHETIC_TEMPLATES.filter((x: any) => !x.requiredFields)) {
      expect(() => validateCheckInput({ name: t.name, ...t.check }, [])).not.toThrow();
    }
  });
});
