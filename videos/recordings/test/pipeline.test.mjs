// node --test videos/recordings/test/
// The pure parts of the recording pipeline: no browser, ffmpeg or network.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { capIdle, findMarkers, parseCast, redactCast, serializeCast } from '../lib/cast.mjs';
import { CLIPS } from '../lib/clips.mjs';
import { buildFilter, drawtextEscape } from '../lib/ffmpeg.mjs';
import { FILES, MEDIA_BASE, versionsModule } from '../lib/media.mjs';
import { buildVtt, editedTime, keepSegments, resolveTime, timeLabels } from '../lib/timeline.mjs';
import { base32Decode, totp } from '../lib/totp.mjs';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

test('TOTP matches the RFC 6238 test vector', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totp(secret, { time: 59_000 }), '287082');
  assert.equal(totp(secret, { time: 1_111_111_109_000 }), '081804');
});

test('marks resolve with offsets, including cut and speed-up names', () => {
  const marks = { start: 1, deployed: 10, 'sync:cut-end': 8 };
  assert.equal(resolveTime('deployed', marks), 10);
  assert.equal(resolveTime('deployed+1.5', marks), 11.5);
  assert.equal(resolveTime('deployed-2', marks), 8);
  assert.equal(resolveTime('sync:cut-end', marks), 8);
  assert.throws(() => resolveTime('missing', marks), /Unknown mark/);
});

test('cuts are removed, speed-ups kept faster, and both are labelled', () => {
  const marks = { start: 2, 'sync:cut-start': 10, 'sync:cut-end': 100, 'detect:fast-start': 110, 'detect:fast-end': 150, end: 160 };
  const segments = keepSegments(marks, { speeds: { detect: 4 } });
  assert.deepEqual(segments.map((s) => (s.cut ? 'cut' : `${s.from}-${s.to}@${s.speed}`)), ['2-10.6@1', 'cut', '99.4-110@1', '110-150@4', '150-160@1']);
  // 8.6 s, then 10.6 s, then 40 s at 4x (10 s), then 10 s.
  assert.ok(Math.abs(editedTime(160, segments) - (8.6 + 10.6 + 10 + 10)) < 1e-9);
  assert.equal(editedTime(50, segments), 8.6); // inside the cut: the join
  assert.ok(Math.abs(editedTime(130, segments) - (8.6 + 10.6 + 5)) < 1e-9);
  const labels = timeLabels(segments, 1);
  assert.deepEqual(labels.map((l) => l.text), ['1 min 29 s skipped', '4x speed']);
  assert.equal(labels[0].from, 9.6);
  assert.throws(() => keepSegments({ start: 0, end: 10, 'x:cut-start': 2 }), /has no end/);
  assert.throws(() => keepSegments({ start: 5, end: 1 }), /start.*end/);
});

test('captions follow the edit, drop optional steps and refuse unreadable cues', () => {
  const marks = { start: 0, a: 1, 'w:cut-start': 5, 'w:cut-end': 65, b: 66, end: 75 };
  const segments = keepSegments(marks);
  const vtt = buildVtt([
    { from: 'start', to: 'a+3', text: 'First.' },
    { from: 'b', text: 'After the wait.' },
    { from: 'never-set', text: 'Optional step.' },
  ], marks, segments, { offset: 1 });
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:05\.000\nFirst\.\n\n2\n00:00:08\.200 --> 00:00:17\.200\nAfter the wait\./);
  assert.doesNotMatch(vtt, /Optional/);
  assert.throws(() => buildVtt([{ from: 'start', to: 'start+0.5', text: 'Too quick' }], marks, segments), /under/);
  assert.throws(() => buildVtt([{ from: 'start', text: 'Done \u{1F680}' }], marks, segments), /emoji/);
});

const castText = [
  JSON.stringify({ version: 2, width: 100, height: 30 }),
  JSON.stringify([0.1, 'o', '   Platform Server Bootstrap v1.2.0\r\n']),
  JSON.stringify([0.5, 'o', 'Admin password: hunter2-very-secret\r\n']),
  JSON.stringify([1.0, 'o', 'token plat_agent_abcdefghijklmnop12 issued\r\n']),
  JSON.stringify([1.2, 'o', 'key s3cr']),
  JSON.stringify([1.3, 'o', 'etvalue ok\r\n']),
  JSON.stringify([241.3, 'o', '   Platform provisioned successfully!\r\n']),
].join('\n');

test('casts are masked: labelled passwords, tokens, split values and exact secrets', () => {
  const cast = redactCast(parseCast(castText), { secrets: ['s3cretvalue'] });
  const all = cast.events.map((e) => e.data).join('');
  assert.doesNotMatch(all, /hunter2|plat_agent_abc|s3cretvalue|s3cr/);
  assert.match(all, /Admin password: ••••••••/);
  assert.match(all, /Platform Server Bootstrap/);
  assert.equal(parseCast(serializeCast(cast)).events.length, cast.events.length);
});

test('long pauses in a cast are shortened and reported for labels', () => {
  const { cast, skips } = capIdle(parseCast(castText), 2);
  const last = cast.events.at(-1);
  assert.ok(Math.abs(last.time - 3.3) < 1e-9);
  assert.equal(skips.length, 1);
  assert.ok(Math.abs(skips[0].skipped - 238) < 1e-9);
  const markers = findMarkers(cast, { banner: 'Platform Server Bootstrap', done: 'provisioned successfully' });
  assert.equal(markers.banner, 0.1);
  assert.ok(Math.abs(markers.done - 3.3) < 1e-9);
});

test('the filter graph trims, speeds up, joins panes and labels time', () => {
  const marks = { start: 1, 'd:fast-start': 4, 'd:fast-end': 8, end: 10 };
  const segments = keepSegments(marks, { speeds: { d: 4 } });
  const graph = buildFilter({ panes: [{ name: 'main', offset: 0 }, { name: 'term', offset: 0.25 }], segments, labels: timeLabels(segments), fontFile: '/fonts/Plex.otf' });
  assert.match(graph, /\[0:v\]trim=start=1\.000:end=4\.000,setpts=\(PTS-STARTPTS\)\[p0s0\]/);
  assert.match(graph, /\[1:v\]trim=start=3\.750:end=7\.750,setpts=\(PTS-STARTPTS\)\/4\[p1s1\]/);
  assert.match(graph, /\[p0\]\[p1\]hstack=inputs=2/);
  assert.match(graph, /text='4x speed'.*enable='between\(t,3\.000,4\.000\)'/);
  assert.match(graph, /scale=1920:1200/);
  assert.ok(graph.endsWith('[out]'));
  assert.throws(() => drawtextEscape("it's"), /plain text/);
});

test('the media host and clip ids match the landing page', async () => {
  const landing = await readFile(here('../../../platform/portal/src/app/pages/landing/landing-clips.ts'), 'utf8');
  assert.match(landing, new RegExp(`export const MEDIA_BASE = '${MEDIA_BASE.replace(/[./]/g, '\\$&')}';`));
  const ids = [...landing.matchAll(/^\s{4}id: '([a-z-]+)',$/gm)].map((m) => m[1]);
  assert.deepEqual(ids, CLIPS);
  assert.deepEqual(FILES.map((f) => f.suffix), ['.mp4', '.webm', '-poster.jpg', '.en.vtt']);
  const module = versionsModule({ clips: { mcp: { version: 'bbbbbbbbbbbb' }, install: { version: 'aaaaaaaaaaaa' } } });
  assert.match(module, /export const CLIP_VERSIONS: Readonly<Record<string, string>> = \{\n {2}"install": "aaaaaaaaaaaa",\n {2}"mcp": "bbbbbbbbbbbb"\n\};/);
  const current = await readFile(here('../../../platform/portal/src/app/pages/landing/landing-clip-versions.ts'), 'utf8');
  assert.match(current, /export const CLIP_VERSIONS: Readonly<Record<string, string>> = /);
});

test('every caption starts at a mark its clip script really sets', async () => {
  for (const clip of CLIPS) {
    const captions = JSON.parse(await readFile(here(`../captions/${clip}.json`), 'utf8'));
    const source = await readFile(here(`../clips/${clip}.mjs`), 'utf8');
    const set = new Set([
      'start', 'end',
      ...[...source.matchAll(/\bmark\('([^']+)'\)/g)].map((m) => m[1]),
      ...[...source.matchAll(/\bcut\('([^']+)'/g)].flatMap((m) => [`${m[1]}:cut-start`, `${m[1]}:cut-end`]),
      ...[...source.matchAll(/\bfast\('([^']+)'/g)].flatMap((m) => [`${m[1]}:fast-start`, `${m[1]}:fast-end`]),
      ...[...(source.match(/MARKERS = \{([\s\S]*?)\};/)?.[1] ?? '').matchAll(/(\w+):/g)].map((m) => m[1]),
    ]);
    assert.ok(captions.title && captions.cues.length >= 3, `${clip}: title and at least 3 cues`);
    for (const cue of captions.cues) {
      for (const ref of [cue.from, cue.to].filter((r) => r !== undefined)) {
        const name = String(ref).split(/[+-]\d/)[0];
        assert.ok(set.has(name), `${clip}: caption "${cue.text}" uses mark "${name}", which clips/${clip}.mjs never sets`);
      }
      assert.match(cue.text, /^[A-Z].*[.]$/, `${clip}: sentence case, full stop: ${cue.text}`);
    }
  }
});
