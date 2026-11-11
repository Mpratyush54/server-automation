import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import {
  ClickHeatmapData,
  cellCenter,
  cellWeight,
  heatColor,
  renderClickHeatmap,
  rrwebNodeToHtml,
  scrollBars,
  snapshotDocument,
  snapshotToHtml,
} from './heatmap-render';
import { HeatmapsComponent } from './heatmaps.component';

const FIXTURE: ClickHeatmapData = {
  grid: { cols: 100, rows: 100 },
  total: 13,
  maxCell: 10,
  // Hot spot at the centre, a single click near the top-left corner.
  cells: [[50, 50, 10], [10, 10, 1], [51, 50, 2]],
};

function canvas(width = 400, height = 400): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function pixel(c: HTMLCanvasElement, x: number, y: number): number[] {
  return Array.from(c.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data);
}

describe('heatmap rendering helpers', () => {
  it('maps intensity to a blue -> red ramp', () => {
    expect(heatColor(0)).toEqual([37, 99, 235]);
    expect(heatColor(1)).toEqual([239, 68, 68]);
    expect(heatColor(0.5)).toEqual([34, 197, 94]);
    expect(heatColor(NaN)).toEqual([37, 99, 235]);
  });

  it('places cells at their centres and weights with sqrt', () => {
    expect(cellCenter(50, 25, 100, 100, 400, 800)).toEqual({ x: 202, y: 204 });
    expect(cellWeight(10, 10)).toBe(1);
    expect(cellWeight(1, 4)).toBe(0.5);
    expect(cellWeight(0, 4)).toBe(0);
    expect(cellWeight(5, 0)).toBe(0);
  });

  it('draws the fixture on a canvas: hot centre is red, cold corner is blue-ish, empty areas transparent', () => {
    const c = canvas();
    expect(renderClickHeatmap(c, FIXTURE)).toBe(3);
    const hot = pixel(c, ...Object.values(cellCenter(50, 50, 100, 100, 400, 400)) as [number, number]);
    expect(hot[3]).toBeGreaterThan(150);
    expect(hot[0]).toBeGreaterThan(200); // red channel dominates at the hot spot
    expect(hot[2]).toBeLessThan(120);
    const cold = pixel(c, ...Object.values(cellCenter(10, 10, 100, 100, 400, 400)) as [number, number]);
    expect(cold[3]).toBeGreaterThan(0);
    expect(cold[0]).toBeLessThan(hot[0]);
    expect(pixel(c, 395, 395)[3]).toBe(0);
  });

  it('clears the canvas for empty data', () => {
    const c = canvas(100, 100);
    renderClickHeatmap(c, FIXTURE);
    expect(renderClickHeatmap(c, { ...FIXTURE, cells: [] })).toBe(0);
    expect(pixel(c, 50, 50)[3]).toBe(0);
    expect(renderClickHeatmap(c, null)).toBe(0);
  });

  it('builds scroll reach bars in depth order', () => {
    const bars = scrollBars([{ depth: 50, pct: 40 }, { depth: 0, pct: 100 }]);
    expect(bars.map((b) => b.depth)).toEqual([0, 50]);
    expect(bars[0].height).toBe(100);
    expect(bars[1].x).toBe(50);
    expect(scrollBars([])).toEqual([]);
  });

  it('turns an rrweb snapshot into static HTML without scripts or handlers', () => {
    const node = {
      type: 0,
      childNodes: [
        { type: 1, name: 'html' },
        { type: 2, tagName: 'html', attributes: {}, childNodes: [
          { type: 2, tagName: 'head', attributes: {}, childNodes: [
            { type: 2, tagName: 'link', attributes: { rel: 'stylesheet', _cssText: 'body{color:red}' }, childNodes: [] },
            { type: 2, tagName: 'script', attributes: {}, childNodes: [{ type: 3, textContent: 'alert(1)' }] },
          ] },
          { type: 2, tagName: 'body', attributes: { onload: 'x()' }, childNodes: [
            { type: 2, tagName: 'a', attributes: { href: 'javascript:alert(1)', class: 'cta' }, childNodes: [{ type: 3, textContent: '<b>Buy</b>' }] },
            { type: 2, tagName: 'img', attributes: { src: 'https://cdn.example.test/a.png', rr_dataURL: 'x' }, childNodes: [] },
          ] },
        ] },
      ],
    };
    const html = rrwebNodeToHtml(node);
    expect(html).toContain('<style>body{color:red}</style>');
    expect(html).toContain('<a class="cta">&lt;b&gt;Buy&lt;/b&gt;</a>');
    expect(html).toContain('<img src="https://cdn.example.test/a.png">');
    expect(html).not.toMatch(/script|alert|onload|rr_/);
    expect(snapshotToHtml({ type: 2, data: { node } })).toBe(html);
    expect(snapshotToHtml([{ type: 4 }, { type: 2, data: { node } }])).toBe(html);
    expect(snapshotToHtml({ html: '<p>x</p>' })).toBe('<p>x</p>');
    expect(snapshotToHtml({})).toBeNull();
    expect(snapshotDocument('<p>x</p>')).toContain("default-src 'none'");
  });
});

describe('HeatmapsComponent', () => {
  const PID = '11111111-1111-4111-8111-111111111111';

  it('loads pages, renders the click canvas from fixture data and falls back to the grid without replay', async () => {
    TestBed.configureTestingModule({
      imports: [HeatmapsComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: PID }), queryParamMap: convertToParamMap({}) } } },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(HeatmapsComponent);
    fixture.detectChanges();
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r)); };

    http.expectOne((r) => r.url === `/api/projects/${PID}/heatmaps/pages` && r.params.get('viewport') === 'desktop')
      .flush({ pages: [{ page: '/features', clicks: 13, views: 4 }] });
    await settle();
    http.expectOne((r) => r.url === `/api/projects/${PID}/heatmaps` && r.params.get('type') === 'click' && r.params.get('page') === '/features')
      .flush({ ...FIXTURE, page: '/features', topTargets: [{ selector: 'button#cta-primary', count: 10 }] });
    http.expectOne((r) => r.url === `/api/projects/${PID}/heatmaps` && r.params.get('type') === 'scroll')
      .flush({ views: 4, buckets: [], reach: [{ depth: 0, pct: 100 }, { depth: 50, pct: 50 }, { depth: 100, pct: 25 }] });
    await settle();
    // No replay has recorded this page: latest snapshot 404 -> neutral grid with a hint.
    http.expectOne((r) => r.url === `/api/projects/${PID}/replays/latest/snapshot` && r.params.get('page') === '/features')
      .flush({ error: 'No DOM snapshot recorded for this page' }, { status: 404, statusText: 'Not Found' });
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const comp = fixture.componentInstance;
    expect(comp.background).toBe('grid');
    expect(el.querySelector('.stage.grid-bg')).not.toBeNull();
    expect(el.querySelector('iframe')).toBeNull();
    expect(el.textContent).toContain('No session replay has recorded this page yet');
    expect(el.textContent).toContain('button#cta-primary');
    expect(el.textContent).toContain('/features');
    const c = el.querySelector('canvas.heat') as HTMLCanvasElement;
    expect(c.width).toBeGreaterThan(0);
    const hot = cellCenter(50, 50, 100, 100, c.width, c.height);
    expect(pixel(c, hot.x, hot.y)[3]).toBeGreaterThan(100);
    expect(el.querySelectorAll('svg.chart rect').length).toBe(3);
    http.verify();
  });

  it('uses the replay snapshot as a sandboxed, script-free background when available', async () => {
    TestBed.configureTestingModule({
      imports: [HeatmapsComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: PID }), queryParamMap: convertToParamMap({ page: '/features' }) } } },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(HeatmapsComponent);
    fixture.detectChanges();
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r)); };
    http.expectOne((r) => r.url.endsWith('/heatmaps/pages')).flush({ pages: [{ page: '/features', clicks: 13, views: 4 }] });
    await settle();
    http.expectOne((r) => r.params.get('type') === 'click').flush({ ...FIXTURE, page: '/features', topTargets: [] });
    http.expectOne((r) => r.params.get('type') === 'scroll').flush({ views: 0, buckets: [], reach: [] });
    await settle();
    // Newest snapshot of this page from any session (sessionId = latest).
    http.expectOne((r) => r.url === `/api/projects/${PID}/replays/latest/snapshot` && r.params.get('page') === '/features')
      .flush({ html: '<html><head></head><body><h1>Hi</h1><script>alert(1)</script><img src=x onerror=alert(2)></body></html>' });
    await settle();
    fixture.detectChanges();
    const frame = fixture.nativeElement.querySelector('iframe.snapshot') as HTMLIFrameElement;
    expect(fixture.componentInstance.background).toBe('snapshot');
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.srcdoc).toContain('<h1>Hi</h1>');
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).not.toMatch(/<script|onerror/);
    http.verify();
  });
});
