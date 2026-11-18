// Shared <head> handling for prerendered public pages (landing, About, docs).
export const origin = 'https://cairnpaas.dev';

/** Public pages other than docs, in sitemap order. */
export const PUBLIC_PAGES = ['/', '/about'];

export const escapeHtml = value => String(value)
  .replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** JSON-LD that cannot close its <script> element early. */
export const jsonLdScript = data =>
  `<script type="application/ld+json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`;

function setTag(document, pattern, tag) {
  const matches = document.match(new RegExp(pattern, 'g')) ?? [];
  if (matches.length > 1) throw new Error(`The page shell has more than one ${tag}`);
  return matches.length ? document.replace(new RegExp(pattern), () => tag) : document.replace('</head>', () => `${tag}\n</head>`);
}

/**
 * Give a page its own title, description, canonical URL and Open Graph /
 * Twitter tags, replacing the shell's defaults (or adding them when absent).
 */
export function applyHead(shell, { title, description, path, type = 'website', jsonLd = [] }) {
  if (!/<title>[^<]*<\/title>/.test(shell) || !shell.includes('</head>')) throw new Error('The page shell needs <title> and </head>');
  const url = origin + path;
  let document = shell.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`);
  document = setTag(document, '<link rel="canonical"[^>]*>', `<link rel="canonical" href="${escapeHtml(url)}">`);
  for (const [key, value] of [
    ['description', description],
    ['og:type', type], ['og:title', title], ['og:description', description], ['og:url', url],
    ['twitter:title', title], ['twitter:description', description],
  ]) {
    const attribute = key.startsWith('og:') ? 'property' : 'name';
    document = setTag(document, `<meta ${attribute}="${key}"[^>]*>`, `<meta ${attribute}="${key}" content="${escapeHtml(value)}">`);
  }
  for (const data of jsonLd) document = document.replace('</head>', () => `${jsonLdScript(data)}</head>`);
  return document;
}
