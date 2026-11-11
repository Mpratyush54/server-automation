/**
 * Render an rrweb full DOM snapshot as static, inert HTML (#40), e.g. as the
 * background of a heatmap in a sandboxed iframe (`<iframe sandbox srcdoc>`).
 *
 * The snapshot was recorded with masking already applied in the browser. Here we
 * additionally make the markup inert: no scripts, frames, objects, event-handler
 * attributes, `javascript:` URLs, forms that submit, or meta refresh, and a CSP
 * that forbids scripts is prepended. Blocked elements become grey placeholders of
 * the recorded size. Inlined stylesheets (`_cssText`) become `<style>` blocks.
 */

/** rrweb-snapshot NodeType */
const DOCUMENT = 0;
const DOCUMENT_TYPE = 1;
const ELEMENT = 2;
const TEXT = 3;
const CDATA = 4;
const COMMENT = 5;

const DROP_TAGS = new Set(['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'template', 'base']);
const VOID_TAGS = new Set(['area', 'br', 'col', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'cite', 'data', 'srcset']);
const MAX_DEPTH = 400;
const MAX_HTML = 5 * 1024 * 1024;

export const SNAPSHOT_CSP = "default-src 'none'; style-src 'unsafe-inline' https: http: data:; img-src https: http: data:; font-src https: http: data:; media-src 'none'; script-src 'none'; frame-src 'none'; form-action 'none'";

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

function cssEsc(s: string): string {
  // Inside <style> (raw text): no '<' at all, so CSS can never close the element.
  // `\3c ` is the CSS escape for '<' (valid inside CSS strings and identifiers).
  return s.replace(/</g, '\\3c ');
}

function unsafeUrl(v: string): boolean {
  const t = v.replace(/[\u0000- ]+/g, '').toLowerCase();
  return t.startsWith('javascript:') || t.startsWith('vbscript:') || (t.startsWith('data:') && !t.startsWith('data:image/'));
}

function attrString(tag: string, attrs: Record<string, unknown>): string {
  let out = '';
  for (const [rawName, rawValue] of Object.entries(attrs || {})) {
    const name = rawName.toLowerCase();
    if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name)) continue;
    if (name.startsWith('on') || name.startsWith('rr_') || name === '_csstext' || name === 'srcdoc') continue;
    if (tag === 'meta' && name === 'http-equiv') continue;
    if (tag === 'form' && (name === 'action' || name === 'method')) continue;
    if (rawValue === null || rawValue === undefined || rawValue === false) continue;
    const value = rawValue === true ? '' : String(rawValue);
    if (URL_ATTRS.has(name) && unsafeUrl(value)) continue;
    if (name === 'style' && /expression\s*\(|javascript:/i.test(value)) continue;
    out += value === '' && rawValue === true ? ` ${name}` : ` ${name}="${escAttr(value)}"`;
  }
  return out;
}

function render(node: any, depth: number, parts: string[], parentTag: string): void {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;
  switch (node.type) {
    case DOCUMENT:
      for (const c of node.childNodes || []) render(c, depth + 1, parts, '');
      return;
    case DOCUMENT_TYPE:
      parts.push('<!DOCTYPE html>');
      return;
    case TEXT: {
      const text = String(node.textContent ?? '');
      parts.push(parentTag === 'style' ? cssEsc(text) : esc(text));
      return;
    }
    case CDATA:
    case COMMENT:
      return;
    case ELEMENT: {
      const tag = String(node.tagName || '').toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(tag) || DROP_TAGS.has(tag)) return;
      const attrs = (node.attributes || {}) as Record<string, unknown>;
      if (node.needBlock || attrs.rr_width || attrs.rr_height) {
        const w = escAttr(String(attrs.rr_width || '0px'));
        const h = escAttr(String(attrs.rr_height || '0px'));
        parts.push(`<div style="width:${w};height:${h};background:#d4d4d8"></div>`);
        return;
      }
      const css = typeof attrs._cssText === 'string' ? attrs._cssText : null;
      if (tag === 'link' && css !== null) {
        parts.push(`<style>${cssEsc(css)}</style>`);
        return;
      }
      if (tag === 'style' && css !== null) {
        parts.push(`<style>${cssEsc(css)}</style>`);
        return;
      }
      if (tag === 'link' && String(attrs.rel || '').toLowerCase() !== 'stylesheet') return; // preload/prefetch/etc.
      parts.push(`<${tag}${attrString(tag, attrs)}>`);
      if (VOID_TAGS.has(tag)) return;
      if (tag === 'head') parts.push(`<meta http-equiv="Content-Security-Policy" content="${escAttr(SNAPSHOT_CSP)}">`);
      for (const c of node.childNodes || []) render(c, depth + 1, parts, tag);
      parts.push(`</${tag}>`);
      return;
    }
    default:
      return;
  }
}

/** HTML for an rrweb serialized node tree (FullSnapshot `data.node`). */
export function snapshotToHtml(node: any): string {
  const parts: string[] = [];
  render(node, 0, parts, '');
  let html = parts.join('');
  if (!/<head[\s>]/i.test(html)) {
    html = `<meta http-equiv="Content-Security-Policy" content="${escAttr(SNAPSHOT_CSP)}">` + html;
  }
  if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
  return html;
}
