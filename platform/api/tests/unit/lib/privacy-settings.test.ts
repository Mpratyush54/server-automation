import {
  mergeRetention,
  parseConsentDefaultsPatch,
  parseRetentionPatch,
  parseScrubRulesPatch,
} from '../../../src/lib/privacy-settings';
import { DEFAULT_RETENTION_DAYS } from '../../../src/entities/TelemetryPrivacySettings';

describe('mergeRetention', () => {
  it('fills defaults and clamps', () => {
    expect(mergeRetention({})).toEqual(DEFAULT_RETENTION_DAYS);
    expect(mergeRetention({ replays: 3, logs: 400 }).replays).toBe(3);
    expect(mergeRetention({ logs: 400 }).logs).toBe(365);
  });
});

describe('parseRetentionPatch', () => {
  it('accepts valid days and rejects out-of-range', () => {
    expect(parseRetentionPatch({ logs: 14, errors: 60 })).toEqual({
      ok: true,
      value: { logs: 14, errors: 60 },
    });
    expect(parseRetentionPatch({ logs: 0 }).ok).toBe(false);
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
