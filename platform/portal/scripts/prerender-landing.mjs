// Prerenders the public landing page (/), About (/about) and Pricing (/pricing) from their
// Angular components, so crawlers, link previews and visitors without
// JavaScript get the real content. Angular replaces it when it boots.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHead, origin } from './prerender-head.mjs';
import { assertNoAngularSyntax, loadTypeScriptModule, renderComponent } from './prerender-template.mjs';

const portal = fileURLToPath(new URL('../', import.meta.url));
const pages = join(portal, 'src/app/pages');

/** The state the static landing HTML shows: the story at its first step, playing, nothing copied, no video started. */
export const LANDING_INITIAL_STATE = {
  step: 0,
  paused: false,
  visible: true,
  installCopied: false,
  landscapeStarted: false,
  portraitStarted: false,
  videoError: '',
};

const PAGES = {
  landing: {
    path: '/',
    module: 'landing/landing.component.ts',
    component: 'LandingComponent',
    state: LANDING_INITIAL_STATE,
    title: 'Cairn — run your apps on your own servers',
    description: 'Cairn installs Git deployments, databases, backups, monitoring and alerts on Ubuntu servers you control. Start on one server, add more for high availability.',
    // Without JavaScript the cover button cannot start playback; show the native controls instead.
    extraHead: '<noscript><style>.lp-play { display: none !important; }</style></noscript>',
    jsonLd: [{
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          '@id': `${origin}/#website`,
          name: 'Cairn',
          url: `${origin}/`,
          description: 'Run your apps on your own servers, and keep them running when one fails.',
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
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
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
    description: 'Why Cairn exists, what it holds itself to and how it is built: a self-hosted platform for teams that run their own servers.',
    extraHead: '',
    jsonLd: [],
  },
  pricing: {
    path: '/pricing',
    module: 'account/pricing.component.ts',
    component: 'PricingComponent',
    state: {},
    title: 'Pricing · Cairn',
    description: 'Cairn is free for personal use. Enterprise starts at $9 per server per month, billed annually, with monitoring, logs, traces and support.',
    extraHead: '',
    jsonLd: [],
  },
};

/** Render one public page into a full HTML document based on the built shell. */
export function renderPublicPage(name, shell) {
  const page = PAGES[name];
  const cls = loadTypeScriptModule(join(pages, page.module))[page.component];
  if (!cls) throw new Error(`${page.module} does not export ${page.component}`);
  const { html, css } = renderComponent(cls, { state: page.state });
  assertNoAngularSyntax(html, page.path);
  const head = applyHead(shell, { title: page.title, description: page.description, path: page.path, jsonLd: page.jsonLd });
  return head.replace('<app-root></app-root>', () =>
    `<app-root><style id="prerender-styles">${css}</style>${page.extraHead}${html}</app-root>`);
}

export async function prerenderPublicPages({ outputDir = join(portal, 'dist/portal/browser') } = {}) {
  const shell = await readFile(join(outputDir, 'index.html'), 'utf8');
  if (!shell.includes('<app-root></app-root>')) throw new Error('Build the portal before prerendering the public pages');
  const home = renderPublicPage('landing', shell);
  const about = renderPublicPage('about', shell);
  const pricing = renderPublicPage('pricing', shell);
  // nginx serves /about and /pricing from /prerender/<page>/index.html, like docs pages.
  for (const [name, html] of [['about', about], ['pricing', pricing]]) {
    const file = join(outputDir, 'prerender', name, 'index.html');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, html);
  }
  await writeFile(join(outputDir, 'index.html'), home);
  return { home, about, pricing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prerenderPublicPages();
  console.log('Prerendered /, /about and /pricing from their Angular components with per-page metadata.');
}
