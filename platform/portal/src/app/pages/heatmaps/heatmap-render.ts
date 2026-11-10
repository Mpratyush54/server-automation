/**
 * Pure rendering helpers for the Heatmaps view (unit-tested in heatmap-render.spec.ts).
 *
 * Click data arrives as a sparse grid (`[cellX, cellY, count]`, 100 x 100 cells over the whole
 * document). We draw one soft alpha blob per cell (intensity ~ sqrt(count / max)), then map
 * the accumulated alpha to a blue -> cyan -> green -> yellow -> red ramp.
 */

export interface ClickHeatmapData {
  grid: { cols: number; rows: number };
  maxCell: number;
  total: number;
  cells: Array<[number, number, number]>;
}

export interface ScrollReachPoint {
  depth: number;
  pct: number;
}

const RAMP: Array<[number, [number, number, number]]> = [
  [0, [37, 99, 235]],
  [0.25, [6, 182, 212]],
  [0.5, [34, 197, 94]],
  [0.75, [250, 204, 21]],
  [1, [239, 68, 68]],
];

/** Colour for intensity t (0..1). */
export function heatColor(t: number): [number, number, number] {
  const v = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i];
    if (v <= t1) {
      const [t0, c0] = RAMP[i - 1];
      const f = (v - t0) / (t1 - t0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f)) as [number, number, number];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/** Cell centre in canvas pixels. */
export function cellCenter(cellX: number, cellY: number, cols: number, rows: number, width: number, height: number): { x: number; y: number } {
  return { x: ((cellX + 0.5) / cols) * width, y: ((cellY + 0.5) / rows) * height };
}

/** Relative weight (0..1) of a cell; sqrt keeps rarely clicked areas visible next to hot spots. */
export function cellWeight(count: number, max: number): number {
  if (!(max > 0) || !(count > 0)) return 0;
  return Math.sqrt(Math.min(1, count / max));
}

/**
 * Draw the click heatmap onto `canvas` (its current width/height). Returns the number of
 * blobs drawn. Safe to call with empty data (clears the canvas).
 */
export function renderClickHeatmap(canvas: HTMLCanvasElement, data: ClickHeatmapData | null, opts: { opacity?: number } = {}): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
  if (!ctx) return 0;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (!data || !data.cells.length || !(data.maxCell > 0) || !width || !height) return 0;
  const cols = data.grid?.cols || 100;
  const rows = data.grid?.rows || 100;
  const radius = Math.max(10, Math.min(48, (width / cols) * 3));
  let drawn = 0;
  for (const [cx, cy, count] of data.cells) {
    const w = cellWeight(count, data.maxCell);
    if (!w) continue;
    const { x, y } = cellCenter(cx, cy, cols, rows, width, height);
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(0,0,0,${w})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    drawn++;
  }
  // Colourise: alpha -> ramp colour.
  const img = ctx.getImageData(0, 0, width, height);
  const px = img.data;
  const opacity = opts.opacity ?? 0.85;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (!a) continue;
    const [r, g, b] = heatColor(a / 255);
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = Math.round(Math.min(255, 40 + a) * opacity);
  }
  ctx.putImageData(img, 0, 0);
  return drawn;
}

/** Bars for the scroll-depth chart: x position (%), height (% of chart). */
export function scrollBars(reach: ScrollReachPoint[]): Array<{ depth: number; pct: number; x: number; width: number; height: number }> {
  const pts = [...(reach || [])].sort((a, b) => a.depth - b.depth);
  if (!pts.length) return [];
  const width = 100 / pts.length;
  return pts.map((p, i) => ({ depth: p.depth, pct: p.pct, x: i * width, width: width * 0.8, height: Math.max(0, Math.min(100, p.pct)) }));
}

// ---------------------------------------------------------------- replay snapshot -> HTML

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const DROP = new Set(['script', 'noscript', 'iframe', 'object', 'embed', 'frame', 'frameset', 'form']);

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Serialise an rrweb full-snapshot node tree to static HTML (no scripts, no handlers). */
export function rrwebNodeToHtml(node: any, depth = 0): string {
  if (!node || typeof node !== 'object' || depth > 200) return '';
  const kids = () => (Array.isArray(node.childNodes) ? node.childNodes.map((c: any) => rrwebNodeToHtml(c, depth + 1)).join('') : '');
  switch (node.type) {
    case 0: // Document
      return kids();
    case 1: // DocumentType
      return '<!DOCTYPE html>';
    case 2: { // Element
      const tag = String(node.tagName || 'div').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'div';
      if (DROP.has(tag)) return '';
      const attrs = (node.attributes || {}) as Record<string, unknown>;
      if (tag === 'link' && typeof attrs['_cssText'] === 'string') return `<style>${String(attrs['_cssText']).replace(/<\/style/gi, '')}</style>`;
      let attrText = '';
      for (const [k, v] of Object.entries(attrs)) {
        const key = k.toLowerCase();
        if (key.startsWith('_') || key.startsWith('on') || key.startsWith('rr_') || !/^[a-z][a-z0-9:_.-]*$/.test(key)) continue;
        if (v === false || v === null || v === undefined) continue;
        const val = String(v);
        if ((key === 'href' || key === 'src' || key === 'action' || key === 'xlink:href') && /^\s*javascript:/i.test(val)) continue;
        attrText += v === true || v === '' ? ` ${key}` : ` ${key}="${esc(val)}"`;
      }
      if (VOID.has(tag)) return `<${tag}${attrText}>`;
      const inner = tag === 'style' && typeof attrs['_cssText'] === 'string' ? String(attrs['_cssText']).replace(/<\/style/gi, '') : kids();
      return `<${tag}${attrText}>${inner}</${tag}>`;
    }
    case 3: // Text
      return node.isStyle ? String(node.textContent || '').replace(/<\/style/gi, '') : esc(String(node.textContent || ''));
    default: // CDATA, comments
      return '';
  }
}

/**
 * Accepts the replay snapshot endpoint's response in any of the plausible shapes (HTML string,
 * `{ html }`, an rrweb full-snapshot event / node, `{ snapshot }`, or an event array) and
 * returns HTML, or null when nothing usable is there.
 */
export function snapshotToHtml(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === 'string') return body.trim() ? body : null;
  if (Array.isArray(body)) {
    const full = body.find((e: any) => e && e.type === 2 && e.data?.node);
    return full ? snapshotToHtml(full) : null;
  }
  const b = body as any;
  if (typeof b.html === 'string') return b.html || null;
  if (b.snapshot) return snapshotToHtml(b.snapshot);
  if (b.events) return snapshotToHtml(b.events);
  if (b.type === 2 && b.data?.node) return rrwebNodeToHtml(b.data.node) || null;
  if (b.node) return rrwebNodeToHtml(b.node) || null;
  if (typeof b.type === 'number' && Array.isArray(b.childNodes)) return rrwebNodeToHtml(b) || null;
  return null;
}

/** CSP injected into the sandboxed snapshot document: no scripts, no network except images/fonts/styles over https/data. */
export const SNAPSHOT_CSP = "default-src 'none'; style-src 'unsafe-inline' https: data:; img-src https: data:; font-src https: data:";

/** Wrap sanitised snapshot HTML with the CSP meta and a base style (no scrollbars in the frame). */
export function snapshotDocument(sanitizedHtml: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP}"><style>html,body{overflow:hidden!important}</style>`;
  if (/<head[^>]*>/i.test(sanitizedHtml)) return sanitizedHtml.replace(/<head[^>]*>/i, (m) => m + head);
  return `<!DOCTYPE html><html><head>${head}</head><body>${sanitizedHtml}</body></html>`;
}

/** Representative layout width per viewport bucket (the snapshot frame is rendered at this width). */
export function viewportWidth(v: string): number {
  return v === 'mobile' ? 390 : v === 'tablet' ? 820 : 1280;
}
