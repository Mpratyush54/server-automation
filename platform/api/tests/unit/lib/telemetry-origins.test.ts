import { Environment } from '../../../src/entities/Environment';
import { Project } from '../../../src/entities/Project';
import { ProjectConfig } from '../../../src/entities/ProjectConfig';
import { Secret } from '../../../src/entities/Secret';
import { encryptValue } from '../../../src/lib/secrets-encryption';
import {
  collectOriginSources,
  MAX_ORIGINS,
  OriginsConfigMapApi,
  syncTelemetryOrigins,
  unionOrigins,
  affectsTelemetryOrigins,
} from '../../../src/lib/telemetry-origins';

const KEY = 'k'.repeat(64);

function fakeDs(rows: { projects?: any[]; envs?: any[]; configs?: any[]; secrets?: any[] }) {
  const by = new Map<any, any[]>([
    [Project, rows.projects || []],
    [Environment, rows.envs || []],
    [ProjectConfig, rows.configs || []],
    [Secret, rows.secrets || []],
  ]);
  return {
    getRepository: (entity: any) => ({
      find: async (opts: any = {}) => {
        const where = opts.where || {};
        return (by.get(entity) || []).filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
    }),
  } as any;
}

function fakeApi(initial: string | null): OriginsConfigMapApi & { writes: string[] } {
  let current = initial;
  const writes: string[] = [];
  return {
    writes,
    read: async () => current,
    write: async (c: string) => {
      writes.push(c);
      current = c;
    },
  };
}

const quiet = () => {};

describe('unionOrigins', () => {
  it('normalises, de-duplicates and sorts origins from every source', () => {
    const out = unionOrigins([
      { envDomain: 'shop-dev.platform.test', projectDomain: 'Shop.Example.net' },
      { configured: 'https://shop.example.net/, http://localhost:4200 https://*.preview.example.org' },
      { configured: 'javascript:alert(1), https://x.test/path, *, ftp://files.example.org, https://a.test:99999999' },
      { envDomain: 'app.example.com' }, // placeholder domains are ignored
    ], quiet);
    expect(out).toEqual([
      'http://localhost:4200',
      'https://*.preview.example.org',
      'https://shop-dev.platform.test',
      'https://shop.example.net',
    ]);
    expect(out).not.toContain('*');
  });

  it('caps the list size', () => {
    const many = Array.from({ length: MAX_ORIGINS + 50 }, (_, i) => ({ configured: `https://h${i}.example.org` }));
    const log = jest.fn();
    expect(unionOrigins(many, log)).toHaveLength(MAX_ORIGINS);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('50 origin(s) dropped'));
  });
});

describe('collectOriginSources', () => {
  it('includes live projects, environments, plain config and secrets for the key only', async () => {
    const ds = fakeDs({
      projects: [
        { id: 'p1', domain: 'one.example.org', isActive: true, deletedAt: null },
        { id: 'p2', domain: 'gone.example.org', isActive: false, deletedAt: new Date() },
      ],
      envs: [
        { id: 'e1', projectId: 'p1', domain: 'p1-dev.platform.test', isActive: true },
        { id: 'e2', projectId: 'p2', domain: 'p2-dev.platform.test', isActive: true },
        { id: 'e3', projectId: 'p1', domain: 'p1-old.platform.test', isActive: false },
      ],
      configs: [
        { projectId: 'p1', key: 'TELEMETRY_ALLOWED_ORIGINS', value: 'http://localhost:4200', isSecret: false },
        { projectId: 'p2', key: 'TELEMETRY_ALLOWED_ORIGINS', value: 'https://deleted.example.org', isSecret: false },
        { projectId: 'p1', key: 'OTHER', value: 'https://other.example.org', isSecret: false },
      ],
      secrets: [
        { projectId: 'p1', key: 'TELEMETRY_ALLOWED_ORIGINS', isActive: true, encryptedValue: encryptValue('https://secret.example.org', KEY) },
        { projectId: 'p1', key: 'TELEMETRY_ALLOWED_ORIGINS', isActive: true, encryptedValue: 'garbage' },
      ],
    });
    const out = unionOrigins(await collectOriginSources(ds, KEY), quiet);
    expect(out).toEqual([
      'http://localhost:4200',
      'https://one.example.org',
      'https://p1-dev.platform.test',
      'https://secret.example.org',
    ]);
  });
});

describe('syncTelemetryOrigins', () => {
  const ds = fakeDs({
    projects: [{ id: 'p1', domain: null, isActive: true, deletedAt: null }],
    configs: [{ projectId: 'p1', key: 'TELEMETRY_ALLOWED_ORIGINS', value: 'https://b.example.org https://a.example.org', isSecret: false }],
  });

  it('writes the union when it differs and is idempotent afterwards', async () => {
    const api = fakeApi('[]');
    expect(await syncTelemetryOrigins({ ds, api, enabled: true, log: quiet })).toBe('written');
    expect(api.writes).toEqual(['["https://a.example.org","https://b.example.org"]']);
    expect(await syncTelemetryOrigins({ ds, api, enabled: true, log: quiet })).toBe('unchanged');
    expect(api.writes).toHaveLength(1);
  });

  it('writes when the key is absent', async () => {
    const api = fakeApi('');
    expect(await syncTelemetryOrigins({ ds, api, enabled: true, log: quiet })).toBe('written');
  });

  it('shrinks the list when a variable is deleted', async () => {
    const api = fakeApi('["https://a.example.org","https://b.example.org","https://old.example.org"]');
    await syncTelemetryOrigins({ ds, api, enabled: true, log: quiet });
    expect(api.writes).toEqual(['["https://a.example.org","https://b.example.org"]']);
  });

  it('does not create a missing ConfigMap', async () => {
    const api = fakeApi(null);
    expect(await syncTelemetryOrigins({ ds, api, enabled: true, log: quiet })).toBe('missing');
    expect(api.writes).toHaveLength(0);
  });

  it('does nothing without the observability backend', async () => {
    const api = fakeApi('[]');
    expect(await syncTelemetryOrigins({ ds, api, enabled: false, log: quiet })).toBe('disabled');
    expect(api.writes).toHaveLength(0);
  });
});

describe('affectsTelemetryOrigins', () => {
  it('matches the config key only', () => {
    expect(affectsTelemetryOrigins('TELEMETRY_ALLOWED_ORIGINS')).toBe(true);
    expect(affectsTelemetryOrigins('telemetry_allowed_origins')).toBe(false);
    expect(affectsTelemetryOrigins('API_URL')).toBe(false);
    expect(affectsTelemetryOrigins(undefined)).toBe(false);
  });
});
