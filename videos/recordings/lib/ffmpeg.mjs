// Builds the ffmpeg filter graph that turns raw pane recordings into the
// edited clip. Pure (strings in, strings out) so it is unit-tested; the
// post-processing script runs ffmpeg with it on the recording VM.

export const OUTPUT = { width: 1920, height: 1200, fps: 30 };
const BG = '0x16181B';

/**
 * Text for drawtext. Labels and titles are short plain sentences; anything
 * that would need filter-graph escaping is refused rather than escaped.
 */
export function drawtextEscape(text) {
  const value = String(text);
  if (!/^[\w .,()-]+$/.test(value)) throw new Error(`Use plain text for on-screen labels: ${value}`);
  return value;
}

/**
 * @param {object} o
 * @param {{ name: string, offset: number }[]} o.panes  in left-to-right order
 * @param {object[]} o.segments  from timeline.keepSegments
 * @param {{ from: number, to: number, text: string }[]} o.labels  edited-video times
 * @param {string} o.fontFile
 * @param {string} [o.title]  shows a one-second title card first when set
 * @returns {string} filter graph whose output pad is [out]
 */
export function buildFilter({ panes, segments, labels, fontFile, title }) {
  const keep = segments.filter((s) => !s.cut && !s.label);
  if (!keep.length) throw new Error('Nothing to keep');
  const parts = [];
  panes.forEach((pane, p) => {
    keep.forEach((segment, k) => {
      const start = Math.max(0, segment.from - pane.offset).toFixed(3);
      const end = Math.max(0, segment.to - pane.offset).toFixed(3);
      const speed = segment.speed === 1 ? '' : `/${segment.speed}`;
      parts.push(`[${p}:v]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)${speed}[p${p}s${k}]`);
    });
    parts.push(`${keep.map((_, k) => `[p${p}s${k}]`).join('')}concat=n=${keep.length}:v=1:a=0[p${p}]`);
  });
  const font = `fontfile='${fontFile.replace(/:/g, '\\:')}'`;
  let current = panes.length > 1 ? `${panes.map((_, p) => `[p${p}]`).join('')}hstack=inputs=${panes.length}` : '[p0]null';
  current += `,fps=${OUTPUT.fps},scale=${OUTPUT.width}:${OUTPUT.height}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${OUTPUT.width}:${OUTPUT.height}:(ow-iw)/2:(oh-ih)/2:color=${BG},setsar=1`;
  if (title) {
    parts.push(`${current},format=yuv420p[body]`);
    parts.push(`color=c=${BG}:s=${OUTPUT.width}x${OUTPUT.height}:r=${OUTPUT.fps}:d=1,format=yuv420p,drawtext=${font}:expansion=none:text='${drawtextEscape(title)}':fontsize=64:fontcolor=0xE6E7E9:x=(w-tw)/2:y=(h-th)/2,drawtext=${font}:expansion=none:text='Cairn':fontsize=30:fontcolor=0xF2B53A:x=(w-tw)/2:y=(h/2)+70,setsar=1[card]`);
    current = '[card][body]concat=n=2:v=1:a=0';
  }
  for (const label of labels) {
    // A speed label can last a while: it sits one row above the skip labels so both stay readable.
    const y = label.kind === 'speed' ? 'h-th-128' : 'h-th-48';
    current += `,drawtext=${font}:expansion=none:text='${drawtextEscape(label.text)}':fontsize=34:fontcolor=0xE6E7E9:box=1:boxcolor=${BG}@0.88:boxborderw=16:x=w-tw-48:y=${y}:enable='between(t,${label.from.toFixed(3)},${label.to.toFixed(3)})'`;
  }
  parts.push(`${current},format=yuv420p[out]`);
  return parts.join(';');
}
