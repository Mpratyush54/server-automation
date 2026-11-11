import { randomUUID } from 'crypto';
import { bundlePath, fingerprint, frameFunction, groupingFingerprint, parseStack } from '../../../src/lib/error-fingerprint';
import { processErrorEvent, validateErrorEvent } from '../../../src/lib/error-tracking';
import { getDb } from '../../../src/config/database';
import { setAlertEventTestHook } from '../../../src/lib/alert-events';
import { ErrorEvent, ErrorFrame } from '../../../src/lib/error-event';
import * as maps from '../../../src/lib/error-sourcemaps';
jest.mock('../../../src/config/database', () => ({ getDb: jest.fn() }));
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); setAlertEventTestHook(null); });

const origin = 'https://shop.example.test/assets';
// One bug (#156): the same TypeError as each engine reports it, for any build.
const chromium = (main: string, vendor: string, base = 2045) => `TypeError: Cannot read properties of undefined (reading 'total')
    at pushError (https://shop.example.test/node_modules/@mpratyush54/sdk-react/dist/index.js:1:500)
    at computeTotal (${origin}/${main}:1:${base})
    at HTMLButtonElement.onCheckout (${origin}/${main}:1:${base + 1265})
    at Object.callback (${origin}/${vendor}:2:100)
    at ${origin}/${vendor}:2:900`;
const firefox = (main: string, vendor: string, base = 2045) => `computeTotal@${origin}/${main}:1:${base + 1}
onCheckout@${origin}/${main}:1:${base + 1266}
callback@${origin}/${vendor}:2:101
@${origin}/${vendor}:2:901
`;
const webkit = (main: string, vendor: string, base = 2045) => `computeTotal@${origin}/${main}:1:${base - 1}
onCheckout@${origin}/${main}:1:${base + 1264}
callback@${origin}/${vendor}:2:99
[native code]
global code@${origin}/${vendor}:2:899`;
const event = (frames: ErrorFrame[], over: Partial<ErrorEvent> = {}): ErrorEvent => ({ eventId: randomUUID(), type: 'TypeError',
  message: 'x', release: '1.0.0', environment: 'production', frames, ...over });

test('V8 and SpiderMonkey/JavaScriptCore stack strings parse to the same frames', () => {
  const v8 = parseStack(chromium('main.js', 'vendor.js')).slice(1);
  const ff = parseStack(firefox('main.js', 'vendor.js'));
  expect(v8.map(f => f.file)).toEqual(ff.map(f => f.file));
  expect(v8[0]).toEqual({ file: `${origin}/main.js`, line: 1, column: 2044, function: 'computeTotal' });
  expect(ff[0]).toEqual({ file: `${origin}/main.js`, line: 1, column: 2045, function: 'computeTotal' });
  expect(v8[3]).toEqual({ file: `${origin}/vendor.js`, line: 2, column: 899 });
  expect(ff[3]).toEqual({ file: `${origin}/vendor.js`, line: 2, column: 900 });
  expect(parseStack(webkit('main.js', 'vendor.js'))).toHaveLength(4); // "[native code]" skipped
});

test('the same error from chromium, firefox and webkit groups into one fingerprint', () => {
  const [c, f, w] = [chromium, firefox, webkit].map(s => groupingFingerprint(event(parseStack(s('main.3f2a1b9c.js', 'vendor.77aa88bb.js')))));
  expect(c).toMatch(/^v2:[a-f0-9]{64}$/);
  expect(f).toBe(c); expect(w).toBe(c);
  // Legacy keys split by engine; that is the bug being fixed.
  expect(fingerprint(event(parseStack(firefox('main.js', 'v.js'))))).not.toBe(fingerprint(event(parseStack(chromium('main.js', 'v.js')))));
});

test('the same error across builds with hashed bundles and moved coordinates groups once', () => {
  const builds = [
    ['main.3f2a1b9c.js', 'vendor.77aa88bb.js', 2045], ['main.9d8e7f60.js', 'vendor.0011aa22.js', 3170],
    ['main.3f2a1b9c.chunk.js', 'vendor.1.js', 10], ['main.9d8e7f60.chunk.js', 'vendor.2.js', 99],
  ] as const;
  const keys = builds.map(([m, v, b]) => groupingFingerprint(event(parseStack(chromium(m, v, b)))));
  expect(keys[1]).toBe(keys[0]); expect(keys[3]).toBe(keys[2]);
  expect(bundlePath('https://x.test/assets/chunk-ABCD1234.js')).toBe(bundlePath('https://x.test/assets/chunk-ZYXW9876.js'));
  expect(bundlePath('/assets/index-B_xY3a9Z.js')).toBe('/assets/index.js');
  expect(bundlePath('/assets/index-Dq81kLmP.js')).toBe('/assets/index.js');
  expect(bundlePath('/_next/static/chunks/pages/checkout-0f1e2d3c4b5a6978.js')).toBe('/_next/static/chunks/pages/checkout.js');
  expect(bundlePath('/static/4f9c2a1b7e8d/app.js')).toBe('/static/<hash>/app.js');
  expect(bundlePath('/assets/checkout.js')).toBe('/assets/checkout.js'); // readable names untouched
  expect(bundlePath('/assets/my-checkout.js')).toBe('/assets/my-checkout.js');
});

test('different errors stay separate', () => {
  const base = groupingFingerprint(event(parseStack(chromium('main.js', 'vendor.js'))));
  expect(groupingFingerprint(event(parseStack(chromium('main.js', 'vendor.js')), { type: 'RangeError' }))).not.toBe(base);
  const other = chromium('main.js', 'vendor.js').replace('computeTotal', 'applyCoupon');
  expect(groupingFingerprint(event(parseStack(other)))).not.toBe(base);
  expect(groupingFingerprint(event(parseStack(chromium('cart.js', 'vendor.js'))))).not.toBe(base);
  // Frameless errors fall back to the normalised message.
  expect(groupingFingerprint(event([], { message: 'Uncaught order 42 failed' }))).toBe(groupingFingerprint(event([], { message: 'order 7 failed' })));
  expect(groupingFingerprint(event([], { message: 'order 42 failed' }))).not.toBe(groupingFingerprint(event([], { message: 'payment declined' })));
});

test('source-mapped frames distinguish lines in one file but ignore column jitter', () => {
  const raw = event([{ file: `${origin}/main.3f2a1b9c.js`, line: 1, column: 2044 }]);
  const mapped = (line: number, column: number) => ({ ...raw, frames: [{ file: 'src/cart.ts', line, column, function: 'computeTotal' }] });
  const a = groupingFingerprint(raw, mapped(10, 4));
  expect(groupingFingerprint(raw, mapped(10, 5))).toBe(a);
  expect(groupingFingerprint(raw, mapped(20, 4))).not.toBe(a);
  // Unmapped frames never use generated coordinates.
  expect(groupingFingerprint(raw)).toBe(groupingFingerprint({ ...raw, frames: [{ ...raw.frames[0], line: 2, column: 9 }] }));
});

test('function names normalise across engines; anonymous, SDK and browser frames are dropped', () => {
  expect(frameFunction('Object.computeTotal')).toBe('computeTotal');
  expect(frameFunction('async HTMLButtonElement.onCheckout [as handler]')).toBe('onCheckout');
  expect(frameFunction('new Cart')).toBe('Cart');
  expect(frameFunction('Cart/computeTotal')).toBe('computeTotal');
  expect(frameFunction('computeTotal/<')).toBeUndefined();
  expect(frameFunction('global code')).toBeUndefined();
  expect(frameFunction('<anonymous>')).toBeUndefined();
  const app = { file: `${origin}/main.js`, line: 1, column: 1, function: 'computeTotal' };
  const noisy = [{ file: '<anonymous>', line: 1, column: 0 }, { file: 'chrome-extension://abc/inject.js', line: 1, column: 0 },
    { file: `${origin}/node_modules/@grafana/faro-web-sdk/dist/index.js`, line: 1, column: 0 }, { ...app, function: 'Error', file: `${origin}/x.js` }, app,
    { file: `${origin}/node_modules/react-dom/cjs/react-dom.js`, line: 1, column: 0, function: 'invokeGuardedCallback' }];
  expect(groupingFingerprint(event(noisy))).toBe(groupingFingerprint(event([app])));
  // Vendor-only stacks still group by their frames rather than by message.
  const vendor = [{ file: `${origin}/node_modules/react-dom/cjs/react-dom.js`, line: 1, column: 0, function: 'commitRoot' }];
  expect(groupingFingerprint(event(vendor))).not.toBe(groupingFingerprint(event([])));
});

test('RUM payloads may carry a raw stack instead of frames', () => {
  const body = { eventId: randomUUID(), type: 'TypeError', message: 'x', environment: 'production' };
  const fromV8 = validateErrorEvent({ ...body, stack: chromium('main.js', 'vendor.js') });
  const fromGecko = validateErrorEvent({ ...body, frames: [], stack: firefox('main.js', 'vendor.js') });
  expect(fromV8.frames).toHaveLength(5); expect(fromGecko.frames).toHaveLength(4);
  expect(groupingFingerprint(fromV8)).toBe(groupingFingerprint(fromGecko));
  expect(() => validateErrorEvent({ ...body })).toThrow('Expected at most 100 frames');
  expect(() => validateErrorEvent({ ...body, stack: 7 })).toThrow('Expected at most 100 frames');
});

test('issues created with legacy fingerprints keep receiving events; new issues use the v2 key', async () => {
  jest.spyOn(maps, 'symbolicate').mockImplementation(async (_p, e) => e);
  const legacyEvent = event(parseStack(chromium('main.3f2a1b9c.js', 'vendor.js')));
  const issues: any[] = [{ id: 'old', fingerprint: fingerprint(legacyEvent), aliases: [], count: 0, release_counts: {}, latest_release: '1.0.0', status: 'open' }];
  const query = jest.fn(async (sql: string, p: any[]) => {
    if (sql.startsWith('SELECT pg_advisory') || sql.startsWith('SELECT id FROM error_events')) return [];
    if (sql.startsWith('SELECT * FROM error_issues')) return issues.filter(i => p[2].includes(i.fingerprint) || i.aliases.some((a: string) => p[2].includes(a))).slice(0, 1);
    if (sql.startsWith('INSERT INTO error_issues')) { const i = { id: randomUUID(), fingerprint: p[2], aliases: [], count: 0, release_counts: {}, latest_release: p[4], status: 'open' }; issues.push(i); return [i]; }
    if (sql.startsWith('INSERT INTO error_events')) return [{ id: p[1] }];
    if (sql.startsWith('UPDATE error_issues')) { const i = issues.find(x => x.id === p[0]); i.count++; i.aliases = [...new Set([...i.aliases, ...JSON.parse(p[4])])]; return []; }
    throw new Error(sql);
  });
  (getDb as jest.Mock).mockResolvedValue({ transaction: (fn: any) => fn({ query }) });
  await processErrorEvent({ projectId: 'project', event: { ...legacyEvent, eventId: randomUUID() } });
  expect(issues).toHaveLength(1); expect(issues[0].count).toBe(1);
  expect(issues[0].aliases.some((a: string) => a.startsWith('v2:'))).toBe(true);
  // A Firefox event from a new build shares only the v2 alias, which the old issue now carries.
  await processErrorEvent({ projectId: 'project', event: event(parseStack(firefox('main.9d8e7f60.js', 'vendor.js'))) });
  expect(issues).toHaveLength(1); expect(issues[0].count).toBe(2);
  await processErrorEvent({ projectId: 'project', event: event(parseStack(chromium('cart.js', 'vendor.js'))) });
  expect(issues).toHaveLength(2); expect(issues[1].fingerprint).toMatch(/^v2:/);
});
