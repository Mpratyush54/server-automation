import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicMedia = join(root, '../platform/portal/public/media');
await mkdir(publicMedia, { recursive: true });
const stamp = seconds => {
  const value = Math.round(seconds * 1000);
  return `${String(Math.floor(value / 3600000)).padStart(2, '0')}:${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`;
};
function attributes(tag, values) {
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`\\b${name}="[^"]*"`);
    tag = pattern.test(tag) ? tag.replace(pattern, `${name}="${value}"`) : tag.replace(/>$/, ` ${name}="${value}">`);
  }
  return tag;
}
function element(html, id, values) {
  let found = false;
  html = html.replace(/<(?:div|audio)\b[^>]*>/g, tag => {
    if (!tag.includes(`id="${id}"`)) return tag;
    found = true;
    return attributes(tag, values);
  });
  if (!found) throw new Error(`Missing timeline element ${id}`);
  return html;
}
for (const name of ['platform-explainer', 'platform-short']) {
  const directory = join(root, name);
  const metadata = join(directory, 'audio_meta.json');
  const meta = JSON.parse(await readFile(metadata, 'utf8'));
  let html = await readFile(join(directory, 'index.html'), 'utf8');
  let start = 0;
  const captions = ['WEBVTT', ''];
  const durations = [];
  for (const [index, voice] of meta.voices.entries()) {
    const id = basename(voice.path, '.wav');
    const duration = name === 'platform-explainer' ? 15 : Math.max(index ? 12.5 : 8.5, Math.ceil((voice.duration_s + .5) * 1000) / 1000);
    const offset = .15;
    if (voice.duration_s + offset > duration) throw new Error(`Narration exceeds ${name}/${id}'s ${duration}s scene`);
    voice.start_s = Number((start + offset).toFixed(3));
    voice.scene_duration_s = duration;
    html = element(html, `el-${id}`, { 'data-start': start, 'data-duration': duration });
    html = element(html, `el-${id}-voice`, { 'data-start': voice.start_s, 'data-duration': voice.duration_s, 'data-audio-group': 'voiceover' });
    for (const cue of voice.cues ?? []) captions.push(`${stamp(start + offset + cue.start)} --> ${stamp(start + offset + cue.end)}`, cue.text, '');
    durations.push(duration);
    start = Number((start + duration).toFixed(3));
  }
  html = element(html, 'root', { 'data-duration': start });
  html = element(html, 'el-bgm', { 'data-duration': start });
  let sfxStart = durations[0] + 1.5;
  html = html.replace(/<audio\b[^>]*>/g, tag => /id="[^"]*sfx[^"]*"/.test(tag) ? attributes(tag, { 'data-start': sfxStart }) : tag);
  meta.total_duration_s = start;
  if (meta.bgm) meta.bgm.duration_s = start;
  let storyboard = await readFile(join(directory, 'STORYBOARD.md'), 'utf8');
  let sceneIndex = 0;
  storyboard = storyboard.replace(/^duration: .*$/m, `duration: ${start}s`).replace(/^- duration: .*$/gm, () => `- duration: ${durations[sceneIndex++]}s`).replaceAll('Kokoro am_michael', 'Ava (Microsoft neural voice)');
  await writeFile(join(directory, 'STORYBOARD.md'), storyboard);
  await writeFile(join(directory, 'index.html'), html);
  await writeFile(metadata, JSON.stringify(meta, null, 2) + '\n');
  const output = name === 'platform-explainer' ? 'platform-overview' : 'platform-short';
  await writeFile(join(publicMedia, `${output}.en.vtt`), captions.join('\n'));
  console.log(`${name}: ${start}s, ${meta.voices.length} narration clips, ${captions.filter(line => line.includes(' --> ')).length} timed captions`);
}
