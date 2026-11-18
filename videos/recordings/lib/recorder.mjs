// One recording session: a Chromium browser with one or more panes (browser
// contexts), each recording its own video at 1280x800 CSS pixels. Playwright
// captures video frames at CSS size whatever the device scale (a larger
// `size` only pads them with grey), so frames are 1280x800 and the edit
// scales them to 1920x1200. Clip scripts drive the panes with the helpers
// below and record named marks at real UI states; post/process.mjs turns the
// raw videos and marks into the published clip.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SCALE, VIEWPORT, env, outDir, typingDelay } from './config.mjs';
import { sessionInitScript } from './session.mjs';

const overlay = await readFile(fileURLToPath(new URL('./overlay.js', import.meta.url)), 'utf8');

export class Recording {
  /**
   * @param {string} clip  clip id, also the output folder name
   * @param {{ name: string, viewport?: {width:number,height:number}, signedIn?: boolean }[]} panes
   */
  static async open(clip, panes = [{ name: 'main', signedIn: true }]) {
    const recording = new Recording(clip);
    recording.dir = join(outDir(), clip);
    await rm(recording.dir, { recursive: true, force: true });
    await mkdir(join(recording.dir, 'raw'), { recursive: true });
    recording.browser = await chromium.launch({ headless: env('HEADED') !== '1' });
    const theme = env('RECORD_THEME', { fallback: 'dark' });
    for (const pane of panes) {
      const viewport = pane.viewport ?? VIEWPORT;
      const context = await recording.browser.newContext({
        viewport,
        deviceScaleFactor: SCALE,
        colorScheme: theme,
        reducedMotion: 'no-preference',
        recordVideo: { dir: join(recording.dir, 'raw', pane.name), size: { width: viewport.width, height: viewport.height } },
      });
      await context.addInitScript({ content: overlay });
      // The portal reads its theme choice from localStorage; follow RECORD_THEME.
      await context.addInitScript({ content: `try { localStorage.setItem('platform.theme', ${JSON.stringify(theme)}); } catch (e) {}` });
      if (pane.signedIn) await context.addInitScript(await sessionInitScript());
      const page = await context.newPage();
      recording.panes[pane.name] = { context, page, viewport, startedAt: performance.now() };
    }
    recording.t0 = Math.min(...Object.values(recording.panes).map((p) => p.startedAt));
    return recording;
  }

  constructor(clip) {
    this.clip = clip;
    this.panes = {};
    this.marks = {};
    this.speeds = {};
  }

  page(name = 'main') {
    return this.panes[name].page;
  }

  now() {
    return (performance.now() - this.t0) / 1000;
  }

  /** Name the current moment (seconds from the start of the raw video). */
  mark(name) {
    if (this.marks[name] !== undefined) throw new Error(`Mark "${name}" is set twice`);
    this.marks[name] = Number(this.now().toFixed(3));
    console.log(`[${this.clip}] ${this.marks[name].toFixed(1)} s  ${name}`);
  }

  /** Wrap a long wait so the edit removes it and labels the skip. */
  async cut(name, wait) {
    this.mark(`${name}:cut-start`);
    const result = await wait();
    this.mark(`${name}:cut-end`);
    return result;
  }

  /**
   * Wrap a wait that should stay visible but faster (for example while
   * requests keep running). The edit plays it at `factor`x and labels it.
   */
  async fast(name, factor, wait) {
    this.mark(`${name}:fast-start`);
    const result = await wait();
    this.mark(`${name}:fast-end`);
    this.speeds[name] = factor;
    return result;
  }

  /** Close every pane, move the raw videos to out/<clip>/raw/<pane>.webm and save the marks. */
  async close(extra = {}) {
    const videos = {};
    for (const [name, pane] of Object.entries(this.panes)) {
      const video = pane.page.video();
      await pane.context.close();
      const target = join(this.dir, 'raw', `${name}.webm`);
      await rename(await video.path(), target);
      videos[name] = { file: `raw/${name}.webm`, offset: Number(((pane.startedAt - this.t0) / 1000).toFixed(3)), viewport: pane.viewport };
    }
    await this.browser.close();
    await writeFile(join(this.dir, 'marks.json'), JSON.stringify({ clip: this.clip, recordedAt: new Date().toISOString(), videos, marks: this.marks, speeds: this.speeds, ...extra }, null, 2));
    console.log(`[${this.clip}] raw recording saved in ${this.dir}`);
  }

  /** Close the browser without saving, after a failure. */
  async abort() {
    // What the screen showed when the run failed: out/<clip>/failure-<pane>.png (never published).
    for (const [name, pane] of Object.entries(this.panes)) {
      await pane.page.screenshot({ path: join(this.dir, `failure-${name}.png`) }).catch(() => {});
    }
    await this.browser?.close().catch(() => {});
  }
}

// --- Human-paced input -------------------------------------------------------

const pointer = new WeakMap();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A short pause so viewers can read what just changed. Never used to wait for the app. */
// BEAT_SCALE (default 1) shortens or lengthens every reading pause, for tighter cuts.
const beatScale = Number(env('BEAT_SCALE', { fallback: '1' }));
export const beat = (ms = 600) => sleep(ms * beatScale);

/** Glide the visible cursor to the middle of an element. */
export async function moveTo(page, locator) {
  await locator.waitFor({ state: 'visible' });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Element has no box: ${locator}`);
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const from = pointer.get(page) ?? { x: page.viewportSize().width / 2, y: page.viewportSize().height / 2 };
  const distance = Math.hypot(target.x - from.x, target.y - from.y);
  await page.mouse.move(target.x, target.y, { steps: Math.max(8, Math.min(40, Math.round(distance / 14))) });
  pointer.set(page, target);
  return target;
}

/** Move to an element, then click it (the overlay draws the ripple). */
export async function click(page, locator) {
  await moveTo(page, locator);
  await sleep(180);
  await locator.click();
  await sleep(220);
}

/** Type into a field at a human pace. Never use this for passwords or tokens. */
export async function type(page, locator, text, { clear = true } = {}) {
  await click(page, locator);
  if (clear) await locator.fill('');
  const delay = typingDelay();
  for (const char of text) {
    await page.keyboard.type(char);
    await sleep(delay * (0.6 + Math.random() * 0.8));
  }
  await sleep(250);
}

/** Wait for an API response the click triggers. Start waiting before the click. */
export function response(page, pattern, { status = [200, 201, 202, 204], timeout = 120_000 } = {}) {
  return page.waitForResponse((r) => (typeof pattern === 'string' ? r.url().includes(pattern) : pattern.test(r.url())) && status.includes(r.status()), { timeout });
}
