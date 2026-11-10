import { ChangeDetectionStrategy, Component, Input, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { chartPaths, Point } from './observability-api';

export interface ChartSeries { name: string; points: Point[]; color?: string }
export interface ChartMarker { t: number; label: string }

/** Small dependency-free SVG line chart using the observability theme tokens. */
@Component({
  selector: 'app-obs-line-chart',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./obs-theme.css'],
  styles: [`
    :host { display: block; }
    svg { width: 100%; height: auto; display: block; overflow: visible; }
    .axis { fill: var(--obs-faint); font-size: 10px; }
    .grid { stroke: var(--obs-grid); stroke-width: 1; }
    .line { fill: none; stroke-width: 1.6; vector-effect: non-scaling-stroke; }
    .marker { stroke: var(--obs-marker); stroke-dasharray: 3 3; stroke-width: 1; }
    .legend { display: flex; gap: 12px; font-size: 0.75rem; color: var(--obs-muted); margin-top: 4px; flex-wrap: wrap; }
    .swatch { display: inline-block; width: 10px; height: 3px; vertical-align: middle; margin-right: 4px; }
    .title { font-size: 0.8rem; color: var(--obs-muted); margin-bottom: 4px; }
    .nodata { font-size: 0.8rem; color: var(--obs-faint); padding: 24px 0; text-align: center; }
  `],
  template: `
    @if (title) { <div class="title">{{ title }}</div> }
    @if (hasData) {
      <svg [attr.viewBox]="'-44 -6 ' + (width + 52) + ' ' + (height + 24)" role="img" [attr.aria-label]="title || 'chart'">
        <line class="grid" x1="0" [attr.x2]="width" y1="0" y2="0" />
        <line class="grid" x1="0" [attr.x2]="width" [attr.y1]="height / 2" [attr.y2]="height / 2" />
        <line class="grid" x1="0" [attr.x2]="width" [attr.y1]="height" [attr.y2]="height" />
        <text class="axis" x="-6" y="4" text-anchor="end">{{ format(geo.yMax) }}</text>
        <text class="axis" x="-6" [attr.y]="height / 2 + 4" text-anchor="end">{{ format(geo.yMax / 2) }}</text>
        <text class="axis" x="-6" [attr.y]="height + 4" text-anchor="end">0</text>
        <text class="axis" x="0" [attr.y]="height + 16">{{ timeLabel(geo.tMin) }}</text>
        <text class="axis" [attr.x]="width" [attr.y]="height + 16" text-anchor="end">{{ timeLabel(geo.tMax) }}</text>
        @for (m of visibleMarkers; track m.t) {
          <line class="marker" [attr.x1]="markerX(m.t)" [attr.x2]="markerX(m.t)" y1="0" [attr.y2]="height"><title>{{ m.label }}</title></line>
        }
        @for (d of geo.paths; track $index) {
          <path class="line" [attr.d]="d" [attr.stroke]="colorOf($index)"><title>{{ series[$index].name }}</title></path>
        }
      </svg>
      @if (series.length > 1 || visibleMarkers.length) {
        <div class="legend">
          @for (s of series; track s.name) { <span><span class="swatch" [style.background]="colorOf($index)"></span>{{ s.name }}</span> }
          @if (visibleMarkers.length) { <span><span class="swatch" style="background: var(--obs-marker)"></span>Deploys</span> }
        </div>
      }
    } @else {
      <div class="nodata">No data in this time range</div>
    }
  `,
})
export class ObsLineChartComponent implements OnChanges {
  @Input() series: ChartSeries[] = [];
  @Input() markers: ChartMarker[] = [];
  @Input() title = '';
  @Input() unit: 'rate' | 'pct' | 'ms' | 'bytes' | 'cores' | '' = '';
  @Input() width = 600;
  @Input() height = 140;

  geo = chartPaths([], 600, 140);
  hasData = false;
  visibleMarkers: ChartMarker[] = [];

  ngOnChanges(): void {
    const pts = this.series.flatMap((s) => s.points);
    this.hasData = pts.some((p) => p[1] !== null && Number.isFinite(p[1] as number));
    this.geo = chartPaths(this.series.map((s) => s.points), this.width, this.height);
    this.visibleMarkers = (this.markers || []).filter((m) => m.t >= this.geo.tMin && m.t <= this.geo.tMax);
  }

  colorOf(i: number): string {
    return this.series[i]?.color || `var(--obs-series-${(i % 4) + 1})`;
  }

  markerX(t: number): number {
    const span = this.geo.tMax - this.geo.tMin || 1;
    return ((t - this.geo.tMin) / span) * this.width;
  }

  format(v: number): string {
    if (!Number.isFinite(v)) return '';
    switch (this.unit) {
      case 'pct': return `${v.toFixed(v < 10 ? 1 : 0)}%`;
      case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v.toFixed(0)}ms`;
      case 'bytes': return v >= 1 << 30 ? `${(v / (1 << 30)).toFixed(1)}G` : `${(v / (1 << 20)).toFixed(0)}M`;
      case 'rate': return v >= 1 ? `${v.toFixed(1)}/s` : `${(v * 60).toFixed(1)}/m`;
      default: return v >= 100 ? v.toFixed(0) : v.toFixed(2);
    }
  }

  timeLabel(t: number): string {
    if (!Number.isFinite(t) || t <= 0) return '';
    const d = new Date(t * 1000);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}
