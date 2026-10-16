import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
for (const project of ['platform-explainer', 'platform-short']) {
  const directory = join(root, project);
  for (const file of await readdir(join(directory, 'compositions/frames'))) {
    if (!file.endsWith('.html')) continue;
    const path = join(directory, 'compositions/frames', file);
    const id = basename(file, '.html');
    let html = await readFile(path, 'utf8');
    // Composition IDs match their host slots; DOM IDs start with a letter so
    // editor controls and ordinary CSS selectors can address them safely.
    html = html.replace(new RegExp(`(?<![\\w-])${id}-`, 'g'), `f-${id}-`)
      .replace(/\[id=["'](f-[\w-]+)["']\]/g, '#$1')
      .replace(/#root\s*\{[^}]+\}/g, style => style.replace(/width:\s*(1920|1080)px/, 'width:100%').replace(/height:\s*(1920|1080)px/, 'height:100%'));
    let clip = 0;
    html = html.replace(/<(div|section)\b[^>]*\bclass=["'][^"']*\bclip\b[^"']*["'][^>]*>/g, tag => {
      if (/\bid=/.test(tag)) return tag;
      return tag.replace(/^<(div|section)/, `<$1 id="f-${id}-layer-${++clip}"`);
    });
    if (id === '01-own') html = html.replace('font-size:2.4cqw;line-height:.92;', 'font-size:2.4cqw;line-height:1.35;');
    await writeFile(path, html);
  }
  const index = join(directory, 'index.html');
  const html = (await readFile(index, 'utf8'))
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/gsap[^>]*><\/script>/, '<script src="assets/gsap.min.js"></script>')
    .replace(/id="(el-[^"]+-voice)"(?! data-audio-group)/g, 'id="$1" data-audio-group="voiceover"');
  await writeFile(index, html);
}
