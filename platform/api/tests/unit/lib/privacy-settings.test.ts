import {
  applyRetentionPatch,
  defaultRetentionDays,
  retentionOverrides,
  mergeRetention,
  parseConsentDefaultsPatch,
  parseRetentionPatch,
  parseScrubRulesPatch,
} from '../../../src/lib/privacy-settings';
import { DEFAULT_RETENTION_DAYS } from '../../../src/entities/TelemetryPrivacySettings';

describe('mergeRetention', () => {
  it('fills defaults and clamps', () => {
    expect(mergeRetention({}, {})).toEqual(DEFAULT_RETENTION_DAYS);
    expect(mergeRetention({ replays: 3, logs: 400 }, {}).replays).toBe(3);
    expect(mergeRetention({ logs: 400 }, {}).logs).toBe(365);
  });

  it('logs/traces/profiles default to the cluster retention; traces/profiles ignore stored overrides', () => {
    const env = { TELEMETRY_RETENTION_DAYS: '7' } as any;
    expect(mergeRetention({}, env)).toMatchObject({ logs: 7, traces: 7, profiles: 7, replays: 7, errors: 90 });
    expect(mergeRetention({ traces: 99, profiles: 99, logs: 14 }, env)).toMatchObject({ logs: 14, traces: 7, profiles: 7 });
    expect(defaultRetentionDays(env).logs).toBe(7);
  });
});

describe('parseRetentionPatch', () => {
  it('accepts valid days and rejects out-of-range', () => {
    expect(parseRetentionPatch({ logs: 14, errors: 60 })).toEqual({
      ok: true,
      value: { logs: 14, errors: 60 },
    });
    expect(parseRetentionPatch({ logs: 0 }).ok).toBe(false);
    expect(parseRetentionPatch({ errors: 366 }).ok).toBe(false);
    expect(parseRetentionPatch({ errors: 1.5 }).ok).toBe(false);
    expect(parseRetentionPatch({ errors: true }).ok).toBe(false);
  });

  it('null (or empty) clears an override', () => {
    expect(parseRetentionPatch({ errors: null, logs: '' })).toEqual({ ok: true, value: { errors: null, logs: null } });
  });

  it('per-project traces/profiles retention is rejected (cluster-wide); null is accepted', () => {
    const r = parseRetentionPatch({ traces: 14 });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toMatch(/cluster-wide/);
    expect(parseRetentionPatch({ profiles: 3 }).ok).toBe(false);
    expect(parseRetentionPatch({ traces: null, profiles: null })).toEqual({ ok: true, value: { traces: null, profiles: null } });
  });
});

describe('applyRetentionPatch', () => {
  it('sets, clears and keeps overrides; drops legacy traces/profiles', () => {
    const stored = { errors: 30, logs: 14, traces: 5, profiles: 5 };
    expect(applyRetentionPatch(stored, { errors: null })).toEqual({ logs: 14 });
    expect(applyRetentionPatch(stored, { replays: 3 })).toEqual({ errors: 30, logs: 14, replays: 3 });
    expect(applyRetentionPatch({}, {})).toEqual({});
    expect(retentionOverrides(stored)).toEqual({ errors: 30, logs: 14 });
  });
});

describe('parseConsentDefaultsPatch', () => {
  it('parses booleans with defaults', () => {
    expect(parseConsentDefaultsPatch({ replay: true })).toEqual({
      ok: true,
      value: { replay: true, analytics: true },
    });
  });
});

describe('parseScrubRulesPatch', () => {
  it('validates custom rules', () => {
    const ok = parseScrubRulesPatch({
      scrubIps: false,
      rules: [{ id: 'ssn', pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b', replacement: '[SSN]' }],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.scrubIps).toBe(false);
      expect(ok.rules[0].id).toBe('ssn');
    }
    expect(parseScrubRulesPatch({ rules: [{ id: 'bad', pattern: '(' }] }).ok).toBe(false);
  });
});
