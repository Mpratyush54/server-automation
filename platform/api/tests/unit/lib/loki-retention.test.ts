/** Per-project logs retention rendered into Loki runtime overrides. */
import YAML from 'yaml';

jest.mock('../../../src/config/database', () => ({ getDb: async () => { throw new Error('use the injected db'); } }));

import {
  reconcileLokiRetention, renderRuntimeConfig, retentionStreamRules, lokiRetentionSettings, RuntimeConfigMapClient,
} from '../../../src/lib/loki-retention';

const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P2 = 'aaaaaaaa-0000-4000-8000-000000000002';

describe('Loki per-project logs retention', () => {
  it('two rules per project (Alloy and API label), sorted, hours', () => {
    expect(retentionStreamRules([{ projectId: P2, days: 3 }, { projectId: P1.toUpperCase(), days: 14 }, { projectId: 'bad"}', days: 3 }, { projectId: P1, days: 0 }])).toEqual([
      { selector: `{platform_project_id="${P1}"}`, priority: 1, period: '336h' },
      { selector: `{project_id="${P1}"}`, priority: 1, period: '336h' },
      { selector: `{platform_project_id="${P2}"}`, priority: 1, period: '72h' },
      { selector: `{project_id="${P2}"}`, priority: 1, period: '72h' },
    ]);
  });

  it('merges into the existing runtime config and keeps other keys', () => {
    const existing = YAML.stringify({ overrides: { fake: { ingestion_rate_mb: 4 }, other: { x: 1 } }, multi_kv_config: { primary: 'consul' } });
    const out = YAML.parse(renderRuntimeConfig(existing, [{ projectId: P1, days: 7 }])!);
    expect(out.multi_kv_config).toEqual({ primary: 'consul' });
    expect(out.overrides.other).toEqual({ x: 1 });
    expect(out.overrides.fake.ingestion_rate_mb).toBe(4);
    expect(out.overrides.fake.retention_stream).toHaveLength(2);
    // Unchanged -> null (no write).
    expect(renderRuntimeConfig(YAML.stringify(out), [{ projectId: P1, days: 7 }])).toBeNull();
    // Last override removed -> the chart default again.
    expect(renderRuntimeConfig(YAML.stringify({ overrides: { fake: { retention_stream: out.overrides.fake.retention_stream } } }), [])).toBe('{}\n');
    expect(renderRuntimeConfig('{}\n', [])).toBeNull();
  });

  it('reconcile: disabled outside the full profile, skips a missing ConfigMap, writes changes once', async () => {
    const writes: string[] = [];
    let text: string | undefined = '{}\n';
    const client: RuntimeConfigMapClient = {
      read: async () => ({ text, resourceVersion: '1' }),
      write: async (t) => { writes.push(t); text = t; },
    };
    const load = async () => [{ projectId: P1, days: 7 }];
    expect(await reconcileLokiRetention(client, load, lokiRetentionSettings({} as any))).toBe('disabled');
    const on = lokiRetentionSettings({ PLATFORM_OBSERVABILITY: 'enabled' } as any);
    expect(on).toMatchObject({ enabled: true, namespace: 'monitoring', configMap: 'loki-runtime', tenant: 'fake' });
    expect(await reconcileLokiRetention({ read: async () => null, write: async () => { throw new Error('no'); } }, load, on)).toBe('missing');
    expect(await reconcileLokiRetention(client, load, on)).toBe('updated');
    expect(await reconcileLokiRetention(client, load, on)).toBe('unchanged');
    expect(writes).toHaveLength(1);
    expect(YAML.parse(writes[0]).overrides.fake.retention_stream[0]).toEqual({ selector: `{platform_project_id="${P1}"}`, priority: 1, period: '168h' });
  });
});
