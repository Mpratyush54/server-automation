// Prerenders the public landing page (/), About (/about), Pricing (/pricing), Terms (/terms) and Privacy (/privacy) from their
// Angular components, so crawlers, link previews and visitors without
// JavaScript get the real content. Angular replaces it when it boots.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHead, origin } from './prerender-head.mjs';
import { assertNoAngularSyntax, loadTypeScriptModule, renderComponent } from './prerender-template.mjs';

const portal = fileURLToPath(new URL('../', import.meta.url));
const pages = join(portal, 'src/app/pages');

/**
 * The state the static landing HTML shows: the story at its first step,
 * playing, nothing copied. Published clips render at once with the browser's
 * own controls instead of the custom player, so they work without
 * JavaScript; Angular swaps in the player when it starts.
 */
export const LANDING_INITIAL_STATE = {
  step: 0,
  paused: false,
  visible: true,
  installCopied: false,
  lazyClips: false,
};

/** The publisher, referenced from every page's structured data. */
export const ORGANIZATION = {
  '@type': 'Organization',
  '@id': `${origin}/#organization`,
  name: 'Neural Nexus',
  brand: { '@type': 'Brand', name: 'Cairn' },
  url: `${origin}/`,
  logo: `${origin}/apple-touch-icon.png`,
  email: 'legal@cairnpaas.dev',
  sameAs: ['https://github.com/Mpratyush54/server-automation'],
  contactPoint: [
    { '@type': 'ContactPoint', contactType: 'sales', url: `${origin}/pricing#enterprise` },
    { '@type': 'ContactPoint', contactType: 'customer support', url: 'https://github.com/Mpratyush54/server-automation/issues' },
  ],
};

/** A WebPage node for pages whose only structured data is the page itself. */
const webPage = (path, name, type = 'WebPage') => ({
  '@context': 'https://schema.org',
  '@type': type,
  '@id': `${origin}${path}#webpage`,
  url: `${origin}${path}`,
  name,
  isPartOf: { '@type': 'WebSite', '@id': `${origin}/#website` },
  publisher: ORGANIZATION,
});

const plainText = value => value.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** FAQPage data built from the rendered <details><summary>Q</summary><p>A</p> pairs, so it matches the page. */
export function faqJsonLd(html) {
  const items = [...html.matchAll(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>\s*<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map(([, q, a]) => ({ '@type': 'Question', name: plainText(q), acceptedAnswer: { '@type': 'Answer', text: plainText(a) } }));
  if (!items.length) throw new Error('No FAQ entries found to describe');
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items };
}

const PAGES = {
  landing: {
    path: '/',
    module: 'landing/landing.component.ts',
    component: 'LandingComponent',
    state: LANDING_INITIAL_STATE,
    title: 'Cairn â€” a self-hosted platform for your apps, on your own servers',
    description: 'Cairn installs Git deployments, databases, logs, metrics and traces, off-site backups and high availability on Ubuntu servers you control.',
    extraHead: '',
    jsonLd: [{
      '@context': 'https://schema.org',
      '@graph': [
        ORGANIZATION,
        {
          '@type': 'WebSite',
          '@id': `${origin}/#website`,
          name: 'Cairn',
          url: `${origin}/`,
          description: 'Run your apps on your own servers, and keep them running when one fails.',
          publisher: { '@id': `${origin}/#organization` },
          inLanguage: 'en',
        },
        {
          '@type': 'SoftwareApplication',
          '@id': `${origin}/#software`,
          name: 'Cairn',
          url: `${origin}/`,
          applicationCategory: 'DeveloperApplication',
          operatingSystem: 'Linux (Ubuntu)',
          description: 'Self-hosted platform for Git deployments, databases, backups, monitoring and alerts on your own servers, with high availability across several servers.',
          downloadUrl: 'https://github.com/Mpratyush54/server-automation/releases',
          sameAs: 'https://github.com/Mpratyush54/server-automation',
          publisher: { '@id': `${origin}/#organization` },
          license: 'https://github.com/Mpratyush54/server-automation/blob/master/LICENSE',
          offers: [
            { '@type': 'Offer', name: 'Personal', price: '0', priceCurrency: 'USD', url: `${origin}/pricing` },
            { '@type': 'Offer', name: 'Enterprise', price: '9', priceCurrency: 'USD', url: `${origin}/pricing`,
              priceSpecification: { '@type': 'UnitPriceSpecification', price: '9', priceCurrency: 'USD', unitText: 'server per month, billed annually' } },
          ],
        },
      ],
    }],
  },
  about: {
    path: '/about',
    module: 'about/about.component.ts',
    component: 'AboutComponent',
    state: {},
    title: 'About Cairn',
    description: 'What Cairn is and what it holds itself to: a self-hosted platform for teams that run their own servers and keep their data.',
    extraHead: '',
    jsonLd: [webPage('/about', 'About Cairn', 'AboutPage')],
  },
  pricing: {
    path: '/pricing',
    module: 'account/pricing.component.ts',
    component: 'PricingComponent',
    state: {},
    title: 'Pricing Â· Cairn',
    description: 'Cairn is free for personal use. Enterprise starts at $9 per server per month, billed annually, with monitoring, logs, traces and support.',
    extraHead: '',
    jsonLd: [webPage('/pricing', 'Cairn pricing')],
    faq: true,
  },
  terms: {
    path: '/terms',
    module: 'legal/legal-pages.component.ts',
    component: 'TermsComponent',
    state: {},
    title: 'Terms of Service · Cairn',
    description: 'The terms for using cairnpaas.dev, Cairn accounts, license keys, and the license and diagnostics services Cairn installations use.',
    extraHead: '',
    jsonLd: [webPage('/terms', 'Cairn Terms of Service')],
  },
  privacy: {
    path: '/privacy',
    module: 'legal/legal-pages.component.ts',
    component: 'PrivacyComponent',
    state: {},
    title: 'Privacy Policy · Cairn',
    description: 'What personal data Cairn collects through its website, accounts, license check-ins and install diagnostics, why, for how long, and your rights.',
    extraHead: '',
    jsonLd: [webPage('/privacy', 'Cairn Privacy Policy')],
  },
};

/** Render one public page into a full HTML document based on the built shell. */
export function renderPublicPage(name, shell) {
  const page = PAGES[name];
  const cls = loadTypeScriptModule(join(pages, page.module))[page.component];
  if (!cls) throw new Error(`${page.module} does not export ${page.component}`);
  const { html, css } = renderComponent(cls, { state: page.state });
  assertNoAngularSyntax(html, page.path);
  const jsonLd = page.faq ? [...page.jsonLd, faqJsonLd(html)] : page.jsonLd;
  const head = applyHead(shell, { title: page.title, description: page.description, path: page.path, jsonLd });
  return head.replace('<app-root></app-root>', () =>
    `<app-root><style id="prerender-styles">${css}</style>${page.extraHead}${html}</app-root>`);
}

export async function prerenderPublicPages({ outputDir = join(portal, 'dist/portal/browser') } = {}) {
  const shell = await readFile(join(outputDir, 'index.html'), 'utf8');
  if (!shell.includes('<app-root></app-root>')) throw new Error('Build the portal before prerendering the public pages');
  const home = renderPublicPage('landing', shell);
  const about = renderPublicPage('about', shell);
  const pricing = renderPublicPage('pricing', shell);
  const terms = renderPublicPage('terms', shell);
  const privacy = renderPublicPage('privacy', shell);
  // nginx serves the other public pages from /prerender/<page>/index.html, like docs pages.
  for (const [name, html] of [['about', about], ['pricing', pricing], ['terms', terms], ['privacy', privacy]]) {
    const file = join(outputDir, 'prerender', name, 'index.html');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, html);
  }
  await writeFile(join(outputDir, 'index.html'), home);
  return { home, about, pricing, terms, privacy };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prerenderPublicPages();
  console.log('Prerendered /, /about, /pricing, /terms and /privacy from their Angular components with per-page metadata.');
}
