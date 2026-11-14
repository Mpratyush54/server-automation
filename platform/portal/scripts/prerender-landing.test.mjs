// node --test scripts/prerender-landing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { renderPublicPage } from './prerender-landing.mjs';
import { assertNoAngularSyntax, PrerenderError, renderTemplate } from './prerender-template.mjs';

const shell = (await readFile(fileURLToPath(new URL('../src/index.html', import.meta.url)), 'utf8'))
  .replace(/<app-root>[\s\S]*<\/app-root>/, '<app-root></app-root>');

// If this test fails, the landing or About template gained a binding, block or
// expression the prerender does not understand. Teach scripts/prerender-template.mjs
// to render it (or change the template); never let it through unrendered.
for (const page of ['landing', 'about']) {
  test(`the current ${page} template prerenders completely`, () => {
    const html = renderPublicPage(page, shell);
    const body = html.slice(html.indexOf('<app-root>'));
    assertNoAngularSyntax(body.replace(/<style[\s\S]*?<\/style>/g, ''), page);
    // Parses as HTML with one h1 and the shared header and footer.
    const { document } = new JSDOM(html).window;
    assert.equal(document.querySelectorAll('h1').length, 1);
    assert.ok(document.querySelector('app-site-header header.sh'));
    assert.ok(document.querySelector('app-site-footer footer.sf'));
    for (const element of document.querySelectorAll('app-root *')) {
      for (const attribute of element.getAttributeNames()) {
        assert.doesNotMatch(attribute, /^[[(#*]|^routerlink|^ng/i, `<${element.localName} ${attribute}>`);
      }
    }
    for (const link of document.querySelectorAll('app-root a')) assert.ok(link.getAttribute('href'), link.outerHTML);
  });
}

test('the landing hero is rendered from TOPOLOGY_STEPS at step 0', () => {
  const { document } = new JSDOM(renderPublicPage('landing', shell)).window;
  assert.equal(document.querySelector('#topology-caption').textContent, 'Three servers share the work. Your app is served from all of them.');
  assert.deepEqual([...document.querySelectorAll('.lp-log li')].map(item => item.textContent), ['18:05:40all 3 servers healthy']);
  const steps = [...document.querySelectorAll('.lp-steps button')];
  assert.equal(steps.length, 5);
  assert.deepEqual(steps.map(step => step.getAttribute('aria-pressed')), ['true', 'false', 'false', 'false', 'false']);
  assert.equal(document.querySelectorAll('.lp-node-down, .lp-link-down').length, 0);
  assert.deepEqual([...document.querySelectorAll('.lp-node-ip')].map(node => node.textContent), ['10.0.0.11', '10.0.0.12', '10.0.0.13', 'shop.example.com']);
  assert.equal(document.querySelector('.lp-copy').textContent.trim(), 'Copy');
  assert.equal(document.querySelector('.lp-topology-play').textContent.trim(), 'Pause');
  assert.ok(document.querySelector('.video-error').hasAttribute('hidden'));
  for (const video of document.querySelectorAll('video')) {
    assert.ok(video.hasAttribute('controls'));
    assert.equal(video.getAttribute('preload'), 'none');
    assert.match(video.getAttribute('poster'), /^\/media\/.+\?v=[a-f0-9]{12}$/);
  }
  for (const button of document.querySelectorAll('.lp-play')) assert.ok(!button.hasAttribute('hidden'));
});

test('the renderer handles control flow, interpolation and bindings', () => {
  const html = renderTemplate(`
    @for (item of items; track item; let i = $index, last = $last) {<li [class]="'x-' + item" [class.end]="last" [attr.data-i]="i">{{ i + 1 }}. {{ item }}</li>}
    @if (items.length > 5) {many} @else if (items.length) {some} @else {none}
    @switch (mode) { @case ('a') {A} @default {other} }
    <a routerLink="/docs" fragment="top" (click)="go()" #ref [hidden]="false">&lt;docs&gt; {{ label() }}</a>`,
  { items: ['p', 'q'], mode: 'b', label() { return 'R & D'; } });
  assert.match(html, /<li class="x-p" data-i="0">1\. p<\/li><li class="x-q end" data-i="1">2\. q<\/li>/);
  assert.match(html, /some/);
  assert.doesNotMatch(html, /many|none/);
  assert.match(html, /other/);
  assert.match(html, /<a href="\/docs#top">&lt;docs&gt; R &amp; D<\/a>/);
});

for (const [name, template] of [
  ['an unknown name', '{{ missing }}'],
  ['an unknown property', '{{ item.nope }}'],
  ['a pipe', "{{ item.name | uppercase }}"],
  ['an unknown property binding', '<div [title2]="item.name"></div>'],
  ['a style binding', '<div [style.color]="item.name"></div>'],
  ['a structural directive', '<div *ngIf="item"></div>'],
  ['a @defer block', '@defer { <p>later</p> }'],
  ['ng-container', '<ng-container>x</ng-container>'],
  ['a routerLink binding', '<a [routerLink]="item.name">x</a>'],
  ['an Angular directive attribute', '<a routerLink="/" routerLinkActive="on">x</a>'],
]) {
  test(`the renderer fails loudly on ${name}`, () => {
    assert.throws(() => renderTemplate(template, { item: { name: 'n' } }), PrerenderError);
  });
}

test('leftover Angular syntax is detected', () => {
  for (const html of ['<p>{{ x }}</p>', '<p (click)="x()"></p>', '@if (x) {', '<p [hidden]="x"></p>', '<a routerLink="/">']) {
    assert.throws(() => assertNoAngularSyntax(html, 'fixture'), PrerenderError, html);
  }
  assert.doesNotThrow(() => assertNoAngularSyntax('<p>mail asha@example.com</p>', 'fixture'));
});
