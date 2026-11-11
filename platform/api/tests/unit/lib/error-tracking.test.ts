import { randomUUID } from 'crypto';
import { fingerprint, isNewerRelease } from '../../../src/lib/error-fingerprint';
import { validateErrorEvent, processErrorEvent } from '../../../src/lib/error-tracking';
import { mapFrame, parseSourceMap, symbolicate, uploadSourceMap } from '../../../src/lib/error-sourcemaps';
import { getDb } from '../../../src/config/database';
import { setAlertEventTestHook } from '../../../src/lib/alert-events';
import { ErrorEvent } from '../../../src/lib/error-event';
import { getUploadStore } from '../../../src/lib/upload-store';
import { Readable } from 'stream';
import { readFile } from 'fs/promises';
import * as maps from '../../../src/lib/error-sourcemaps';
jest.mock('../../../src/config/database', () => ({ getDb: jest.fn() }));
jest.mock('../../../src/lib/upload-store', () => ({ getUploadStore: jest.fn() }));
const { SourceMapConsumer } = require('source-map');
const fixture = { version: 3, file: 'app.js', sources: ['src/cart.ts'], names: ['checkout'], mappings: 'AASEA' };
const event = (): ErrorEvent => ({ eventId: randomUUID(), type: 'TypeError', message: 'failed for order 42',
  release: '1.0.0', environment: 'production', frames: [{ file: 'https://cdn.example.test/app.js?v=123', line: 1, column: 0 }] });
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); setAlertEventTestHook(null); });

test('fingerprint ignores URL origin, query, message values, release and user but isolates frames/type', () => {
  const a = event(), b = { ...a, release: '2.0.0', userId: 'other', message: 'different message', frames: [{ ...a.frames[0], file: 'https://other.example.test/app.js?x=99' }] };
  expect(fingerprint(a)).toBe(fingerprint(b));
  expect(fingerprint(a)).toBe(fingerprint({ ...a, frames: [{ ...a.frames[0], function: 'renamedByMinifier' }] }));
  expect(fingerprint(a)).not.toBe(fingerprint({ ...b, type: 'RangeError' }));
  expect(fingerprint(a)).not.toBe(fingerprint({ ...b, frames: [{ ...b.frames[0], line: 2 }] }));
  expect(fingerprint({ ...a, frames: [], message: 'order 42 failed' })).toBe(fingerprint({ ...a, frames: [], message: 'order 777 failed' }));
});
test('fixture map resolves minified position to original source line/name; rejects remote indexed maps', () => {
  const consumer = new SourceMapConsumer(parseSourceMap(fixture));
  expect(mapFrame(event().frames[0], consumer)).toEqual({ file: 'src/cart.ts', line: 10, column: 2, function: 'checkout' });
  expect(() => parseSourceMap({ version: 3, sections: [{ url: 'https://untrusted.test/a.map' }] })).toThrow();
  expect(() => parseSourceMap('x'.repeat(6 * 1024 * 1024))).toThrow();
});
test('symbolication caches by immutable map key and keeps raw frames on map outage', async () => {
  const query = jest.fn().mockResolvedValue([{ object_key: 'fixture-key-41' }]);
  (getDb as jest.Mock).mockResolvedValue({ query });
  const get = jest.fn().mockResolvedValue(Readable.from([JSON.stringify(fixture)]));
  (getUploadStore as jest.Mock).mockReturnValue({ get });
  expect((await symbolicate('project', event())).frames[0].line).toBe(10);
  expect((await symbolicate('project', event())).frames[0].file).toBe('src/cart.ts');
  expect(get).toHaveBeenCalledTimes(1);
  query.mockRejectedValue(new Error('storage unavailable'));
  expect((await symbolicate('project', event())).frames[0].line).toBe(1);
});
test('upload persists a private content-addressed map and binds metadata to project/release/file', async () => {
  const query = jest.fn().mockResolvedValue([]);
  (getDb as jest.Mock).mockResolvedValue({ query });
  const put = jest.fn(async (key: string, temp: string) => {
    expect(key).toMatch(/^error-sourcemaps\/[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(temp, 'utf8'))).toEqual(fixture);
  });
  (getUploadStore as jest.Mock).mockReturnValue({ kind: 's3', put });
  await uploadSourceMap('project', '1.2.0', 'https://cdn.example.test/app.js?v=1', fixture);
  expect(put).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][1].slice(0, 3)).toEqual(['project', '1.2.0', '/app.js']);
});
test('validation bounds event fields and copies only the wire contract', () => {
  expect(validateErrorEvent({ ...event(), projectId: 'attacker' })).not.toHaveProperty('projectId');
  expect(() => validateErrorEvent({ ...event(), frames: [{ file: 'x', line: -1, column: 0 }] })).toThrow();
  expect(() => validateErrorEvent({ ...event(), eventId: 'invalid' })).toThrow();
  expect(() => validateErrorEvent({ ...event(), breadcrumbs: Array(101).fill({ message: 'x' }) })).toThrow();
});
test('newer numbered versions regress, delayed older/same versions and known opaque releases do not', () => {
  expect(isNewerRelease('1.10.0', '1.9.0', {})).toBe(true);
  expect(isNewerRelease('1.8.0', '1.9.0', {})).toBe(false);
  expect(isNewerRelease('1.9.0', '1.9.0', {})).toBe(false);
  expect(isNewerRelease('old-sha', 'new-sha', { 'old-sha': 20 })).toBe(false);
  expect(isNewerRelease('next-sha', 'new-sha', {})).toBe(true);
});
test('100 distinct events group once, retries do not count, newer release reopens once and publishes alerts', async () => {
  let issue: any; const ids = new Set(); const alerts: any[] = [];
  setAlertEventTestHook(e => alerts.push(e));
  const query = jest.fn(async (sql: string, p: any[]) => {
    if (sql.includes('error_sourcemaps')) return [];
    if (sql.startsWith('SELECT pg_advisory')) return [];
    if (sql.startsWith('SELECT id FROM error_events')) return ids.has(p[1]) ? [{ id: p[1] }] : [];
    if (sql.startsWith('SELECT * FROM error_issues')) return issue ? [issue] : [];
    if (sql.startsWith('INSERT INTO error_issues')) { issue = { id: randomUUID(), count: 0, release_counts: {}, status: 'open', latest_release: p[4] }; return [issue]; }
    if (sql.startsWith('INSERT INTO error_events')) { if (ids.has(p[1])) return []; ids.add(p[1]); return [{ id: p[1] }]; }
    if (sql.startsWith('UPDATE error_issues')) { issue.count++; issue.release_counts[p[1]] = (issue.release_counts[p[1]] || 0) + 1; issue.latest_release = p[1]; if (p[2]) { issue.status = 'open'; issue.regression = true; } return []; }
    throw new Error('Unexpected query: ' + sql);
  });
  (getDb as jest.Mock).mockResolvedValue({ query, transaction: (f: any) => f({ query }) });
  const events = Array.from({ length: 100 }, event);
  for (const e of events) await processErrorEvent({ projectId: 'project', event: e });
  await processErrorEvent({ projectId: 'project', event: events[0] });
  expect(issue.count).toBe(100); expect(issue.release_counts).toEqual({ '1.0.0': 100 }); expect(alerts).toHaveLength(1);
  issue.status = 'resolved'; issue.resolved_release = '1.0.0';
  await processErrorEvent({ projectId: 'project', event: event() });
  expect(issue.status).toBe('resolved');
  await processErrorEvent({ projectId: 'project', event: { ...event(), release: '1.1.0' } });
  expect(issue.status).toBe('open'); expect(issue.regression).toBe(true); expect(alerts).toHaveLength(2);
  expect(alerts[1]).toMatchObject({ source: 'error-tracking', severity: 'critical' });
});
test('late maps retain the raw issue and changing minified bundles in a new release regress the original group', async () => {
  const issues: any[] = []; const ids = new Set(); const alerts: any[] = [];
  setAlertEventTestHook(e => alerts.push(e));
  const original = [{ file: 'src/cart.ts', function: 'checkout', line: 10, column: 2 }];
  const mapped = jest.spyOn(maps, 'symbolicate').mockImplementation(async (_project, e) => e);
  const query = jest.fn(async (sql: string, p: any[]) => {
    if (sql.startsWith('SELECT pg_advisory')) return [];
    if (sql.startsWith('SELECT id FROM error_events')) return ids.has(p[1]) ? [{ id: p[1] }] : [];
    if (sql.startsWith('SELECT * FROM error_issues')) return issues.filter(i => p[2].includes(i.fingerprint) || i.aliases.some((a: string) => p[2].includes(a)));
    if (sql.startsWith('INSERT INTO error_issues')) {
      const i = { id: randomUUID(), fingerprint: p[2], aliases: [], count: 0, release_counts: {}, latest_release: p[4], status: 'open' };
      issues.push(i); return [i];
    }
    if (sql.startsWith('INSERT INTO error_events')) { ids.add(p[1]); return [{ id: p[1] }]; }
    if (sql.startsWith('UPDATE error_issues')) {
      const i = issues.find(i => i.id === p[0]);
      i.count++; i.release_counts[p[1]] = (i.release_counts[p[1]] || 0) + 1;
      i.aliases = [...new Set([...i.aliases, ...JSON.parse(p[4])])]; i.latest_release = p[3];
      if (p[2]) { i.status = 'open'; i.regression = true; } return [];
    }
    throw new Error(sql);
  });
  (getDb as jest.Mock).mockResolvedValue({ transaction: (fn: any) => fn({ query }) });
  await processErrorEvent({ projectId: 'project', event: event() });
  mapped.mockImplementation(async (_project, e) => ({ ...e, frames: original }));
  await processErrorEvent({ projectId: 'project', event: event() });
  issues[0].status = 'resolved'; issues[0].resolved_release = '1.0.0';
  await processErrorEvent({ projectId: 'project', event: { ...event(), release: '1.1.0', frames: [{ file: '/app.newhash.js', line: 2, column: 400 }] } });
  expect(issues).toHaveLength(1); expect(issues[0]).toMatchObject({ count: 3, regression: true, status: 'open' });
  expect(alerts).toHaveLength(2); expect(alerts[1].dedupeKey).toBe(alerts[0].dedupeKey);
});
test('validation names the offending field and defaults a missing release like the SDKs do', () => {
  const { release: _omit, ...noRelease } = event();
  expect(validateErrorEvent(noRelease).release).toBe('unknown');
  expect(validateErrorEvent({ ...event(), release: '  ' }).release).toBe('unknown');
  expect(validateErrorEvent({ ...event(), release: '2.1.0' }).release).toBe('2.1.0');
  expect(() => validateErrorEvent({ ...event(), release: 42 })).toThrow('Invalid error event field: release must be a string');
  expect(() => validateErrorEvent({ ...event(), release: 'x'.repeat(201) })).toThrow('release exceeds 200 characters');
  const { environment: _env, ...noEnv } = event();
  expect(() => validateErrorEvent(noEnv)).toThrow('Missing error event field: environment');
  expect(() => validateErrorEvent({ ...event(), message: '' })).toThrow('Missing error event field: message');
  expect(() => validateErrorEvent({ ...event(), frames: [{ line: 1, column: 0 }] })).toThrow('Missing error event field: frames[0].file');
  expect(() => validateErrorEvent({ ...event(), breadcrumbs: [{ message: 7 }] })).toThrow('breadcrumbs.message must be a string');
});
