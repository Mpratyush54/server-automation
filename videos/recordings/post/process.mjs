#!/usr/bin/env node
// Edit and encode recorded clips. Run on the recording VM (it needs ffmpeg
// with libx264 and libvpx-vp9; libsvtav1 for --av1). Never on a laptop.
//
//   node post/process.mjs [--title-card] [--av1] <clip...|all>
//
// For each clip in out/<clip>/ (from record.mjs) it:
//   1. keeps the part between the "start" and "end" marks, removes cuts and
//      speeds up "fast" waits, joins side-by-side panes, scales to 1920x1200;
//   2. labels every removed or sped-up stretch on screen ("2 min skipped");
//   3. optionally adds a one-second title card (--title-card);
//   4. encodes H.264 MP4 (faststart) and VP9 WebM (or AV1 with --av1);
//   5. takes a poster frame (mark "poster", else 60% in) and writes WebVTT
//      captions from captions/<clip>.json, timed against the edited video;
//   6. writes out/publish/<clip>.* and out/publish/manifest.json with a
//      content version per clip, for publish.mjs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIPS } from '../lib/clips.mjs';
import { env, outDir } from '../lib/config.mjs';
import { buildFilter } from '../lib/ffmpeg.mjs';
import { buildVtt, editedTime, keepSegments, timeLabels } from '../lib/timeline.mjs';

const args = process.argv.slice(2);
const titleCard = args.includes('--title-card');
const av1 = args.includes('--av1');
const names = args.filter((a) => !a.startsWith('--'));
const clips = names.includes('all') ? CLIPS.filter((c) => existsSync(join(outDir(), c, 'marks.json'))) : names;
if (!clips.length) {
  console.error('Usage: node post/process.mjs [--title-card] [--av1] <clip...|all>');
  process.exit(2);
}

const FONT_CANDIDATES = [
  env('FONT_FILE'),
  '/usr/share/fonts/opentype/ibm-plex/IBMPlexSans-Medium.otf',
  '/usr/share/fonts/truetype/ibm-plex/IBMPlexSans-Medium.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
].filter(Boolean);
const fontFile = FONT_CANDIDATES.find((f) => existsSync(f));
if (!fontFile) throw new Error('No font for labels: apt install fonts-ibm-plex (or set FONT_FILE)');

function ffmpeg(argv) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: 'inherit' });
  if (result.error) throw new Error('ffmpeg is not installed (apt install ffmpeg)');
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status})`);
}

const captionsDir = fileURLToPath(new URL('../captions/', import.meta.url));
const publishDir = join(outDir(), 'publish');
await mkdir(publishDir, { recursive: true });
const manifestFile = join(publishDir, 'manifest.json');
const manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, 'utf8')) : { clips: {} };

for (const clip of clips) {
  const dir = join(outDir(), clip);
  const recorded = JSON.parse(await readFile(join(dir, 'marks.json'), 'utf8'));
  const captions = JSON.parse(await readFile(join(captionsDir, `${clip}.json`), 'utf8'));
  const { marks } = recorded;
  const segments = keepSegments(marks, { speeds: recorded.speeds ?? {}, replaySkips: recorded.replaySkips ?? [] });
  const offset = titleCard ? 1 : 0;
  const labels = timeLabels(segments, offset);
  // Panes left to right: the product on the left, the terminal on the right.
  const panes = Object.entries(recorded.videos).map(([name, v]) => ({ name, offset: v.offset, file: join(dir, v.file) }))
    .sort((a, b) => (a.name === 'main' ? -1 : b.name === 'main' ? 1 : 0));
  const filter = buildFilter({ panes, segments, labels, fontFile, title: titleCard ? captions.title : undefined });
  const edited = join(dir, 'edited.mkv');
  console.log(`== ${clip}: editing ${panes.length} pane(s), ${labels.length} time label(s)`);
  ffmpeg([...panes.flatMap((p) => ['-i', p.file]), '-filter_complex', filter, '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', edited]);

  const duration = editedTime(marks.end, segments, offset);
  if (duration < 20 || duration > 40) console.warn(`   note: ${clip} is ${duration.toFixed(1)} s long; aim for 20-40 s (move marks or add a cut)`);

  const base = join(publishDir, clip);
  ffmpeg(['-i', edited, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', `${base}.mp4`]);
  if (av1) ffmpeg(['-i', edited, '-c:v', 'libsvtav1', '-preset', '6', '-crf', '36', '-pix_fmt', 'yuv420p', '-an', `${base}.webm`]);
  else ffmpeg(['-i', edited, '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-an', `${base}.webm`]);

  const posterAt = marks.poster !== undefined ? editedTime(marks.poster, segments, offset) : duration * 0.6;
  ffmpeg(['-ss', posterAt.toFixed(3), '-i', edited, '-frames:v', '1', '-q:v', '3', `${base}-poster.jpg`]);
  await writeFile(`${base}.en.vtt`, buildVtt(captions.cues, marks, segments, { offset }));

  const hash = createHash('sha256');
  for (const suffix of ['.mp4', '.webm', '-poster.jpg', '.en.vtt']) hash.update(await readFile(`${base}${suffix}`));
  manifest.clips[clip] = { version: hash.digest('hex').slice(0, 12), duration: Number(duration.toFixed(2)), recordedAt: recorded.recordedAt };
  if (recorded.requests) await copyFile(join(dir, 'marks.json'), `${base}.evidence.json`);
  console.log(`   ${clip}: ${duration.toFixed(1)} s, version ${manifest.clips[clip].version}`);
}
await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
console.log(`Ready to publish: ${publishDir}`);
