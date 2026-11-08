import { sanitizeDocsHtml } from './docs-sanitize.mjs';

describe('sanitizeDocsHtml', () => {
  function render(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = sanitizeDocsHtml(html);
    return host;
  }

  it('drops event-handler attributes from raw HTML in Markdown', () => {
    const out = render('<p>hi</p><img src=x onerror=alert(1)>');
    const img = out.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.hasAttribute('onerror')).toBeFalse();
    expect(out.innerHTML).not.toContain('onerror');
  });

  it('drops script elements and javascript: links', () => {
    const out = render('<script>alert(1)</script><a href="javascript:alert(1)">x</a>');
    expect(out.querySelector('script')).toBeNull();
    expect(out.querySelector('a')!.getAttribute('href')).toBeNull();
  });

  it('keeps a mermaid fence that tries to close the container as inert text', () => {
    // What marked emits for ```mermaid\nA</div><script>alert(1)</script>\n```
    const out = render(
      '<pre><code class="language-mermaid">graph TD\nA&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;\n</code></pre>',
    );
    expect(out.querySelector('script')).toBeNull();
    const diagram = out.querySelector('div.mermaid');
    expect(diagram).toBeTruthy();
    expect(diagram!.children.length).toBe(0);
    expect(diagram!.textContent).toBe('graph TD\nA</div><script>alert(1)</script>');
    expect(out.querySelector('pre')).toBeNull();
  });

  it('keeps the markup the docs layout relies on', () => {
    const out = render(
      '<h2 id="before">Before</h2><h3 id="get-apiprojects">x</h3>' +
      '<div class="api-card" id="get-apiprojects-card"><span class="api-method method-get">GET</span></div>' +
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>' +
      '<pre><code class="language-ts">const a = 1;</code></pre>' +
      '<a href="/docs/guides/monitoring#logs">m</a><img src="/media/x.jpg" alt="x">',
    );
    expect(out.querySelector('h2#before')).toBeTruthy();
    expect(out.querySelector('h3#get-apiprojects')).toBeTruthy();
    expect(out.querySelector('div.api-card#get-apiprojects-card span.api-method.method-get')).toBeTruthy();
    expect(out.querySelector('table td')!.textContent).toBe('b');
    expect(out.querySelector('pre code.language-ts')).toBeTruthy();
    expect(out.querySelector('a')!.getAttribute('href')).toBe('/docs/guides/monitoring#logs');
    expect(out.querySelector('img')!.getAttribute('src')).toBe('/media/x.jpg');
  });

  it('removes inline styles and style elements', () => {
    const out = render('<style>body{display:none}</style><p style="position:fixed">x</p>');
    expect(out.querySelector('style')).toBeNull();
    expect(out.querySelector('p')!.hasAttribute('style')).toBeFalse();
  });
});
