import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Flamebearer, FlameRect, flameRects } from './observability-api';

/** Flame graph of a Pyroscope flamebearer (#48); click a frame to zoom, click the root to reset. */
@Component({
  selector: 'app-obs-flamegraph',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./obs-theme.css'],
  styles: [`
    .fg { position: relative; width: 100%; overflow: hidden; font-size: 11px; }
    .fr { position: absolute; height: 18px; box-sizing: border-box; border: 1px solid var(--obs-bg); border-radius: 2px; padding: 0 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; color: #111; line-height: 16px; }
    .fr:hover { filter: brightness(1.1); outline: 1px solid var(--obs-text); }
  `],
  template: `
    @if (!rects.length) {
      <div class="obs-empty"><strong>No profile data</strong>Enable profiling in the platform SDK (Node / Python) and pick a service.</div>
    } @else {
      <div class="obs-faint" style="margin-bottom:6px">{{ total }} {{ unit || 'samples' }} total @if (zoom) { · zoomed into <strong>{{ zoom.name }}</strong> <button class="obs-btn" style="padding:0 6px" (click)="reset()">Reset</button> }</div>
      <div class="fg" [style.height.px]="height" role="img" aria-label="Flame graph">
        @for (r of view; track $index) {
          <div class="fr" [style.left.%]="r.left" [style.width.%]="r.width" [style.top.px]="r.level * 18" [style.background]="r.color" (click)="zoomTo(r.rect)" [title]="r.rect.name + ' — ' + r.share + '% (self ' + r.rect.self + ')'">{{ r.rect.name }}</div>
        }
      </div>
    }
  `,
})
export class ObsFlamegraphComponent implements OnChanges {
  @Input() flamebearer: Flamebearer | null = null;
  @Input() unit: string | null = null;

  rects: FlameRect[] = [];
  view: Array<{ rect: FlameRect; left: number; width: number; level: number; color: string; share: string }> = [];
  zoom: FlameRect | null = null;
  height = 0;
  total = 0;

  ngOnChanges(): void {
    this.rects = this.flamebearer ? flameRects(this.flamebearer) : [];
    this.total = this.flamebearer?.numTicks || 0;
    this.zoom = null;
    this.layout();
  }

  zoomTo(r: FlameRect) {
    this.zoom = r.level === 0 ? null : r;
    this.layout();
  }

  reset() {
    this.zoom = null;
    this.layout();
  }

  private layout() {
    const z = this.zoom;
    const x0 = z ? z.start : 0;
    const w = z ? z.width : 1;
    const minLevel = z ? z.level : 0;
    const visible = this.rects.filter((r) => r.level >= minLevel && r.start >= x0 - 1e-9 && r.start + r.width <= x0 + w + 1e-9 && r.width / w > 0.003);
    this.view = visible.map((r) => ({
      rect: r,
      left: ((r.start - x0) / w) * 100,
      width: (r.width / w) * 100,
      level: r.level - minLevel,
      color: colorFor(r.name),
      share: ((r.width) * 100).toFixed(2),
    }));
    this.height = (Math.max(0, ...this.view.map((v) => v.level)) + 1) * 18;
  }
}

/** Stable warm palette (readable with dark text in both themes). */
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${20 + (h % 40)}, 85%, ${62 + (h % 14)}%)`;
}
