import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { fmtPct, fmtRate, GraphEdge, GraphNode, layoutGraph, PlacedNode } from './observability-api';

/** Service map from Tempo service-graph metrics (#48). Other projects appear as one "(other project)" node. */
@Component({
  selector: 'app-obs-service-map',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./obs-theme.css'],
  styles: [`
    svg { width: 100%; height: auto; display: block; }
    .edge { stroke: var(--obs-faint); stroke-width: 1.4; fill: none; }
    .edge.bad { stroke: var(--obs-bad); }
    .node rect { fill: var(--obs-elevated); stroke: var(--obs-border); rx: 6; }
    .node.own rect { stroke: var(--obs-accent); }
    .node.external rect { stroke-dasharray: 4 3; }
    .node text { fill: var(--obs-text); font-size: 11px; }
    .node .sub { fill: var(--obs-muted); font-size: 9px; }
    .node { cursor: pointer; }
    .elabel { fill: var(--obs-muted); font-size: 9px; }
    marker path { fill: var(--obs-faint); }
  `],
  template: `
    @if (!nodes.length) {
      <div class="obs-empty"><strong>No service graph yet</strong>Instrument services with the platform SDK; edges appear once services call each other.</div>
    } @else {
      <svg [attr.viewBox]="'0 0 ' + width + ' ' + height" role="img" aria-label="Service map">
        <defs><marker id="obs-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker></defs>
        @for (e of placedEdges; track e.key) {
          <path class="edge" [class.bad]="(e.edge.errorRate ?? 0) >= 5" [attr.d]="e.d" marker-end="url(#obs-arrow)"><title>{{ e.edge.source }} → {{ e.edge.target }}: {{ rate(e.edge.requestRate) }}, {{ pct(e.edge.errorRate) }} errors</title></path>
          <text class="elabel" [attr.x]="e.mx" [attr.y]="e.my - 4" text-anchor="middle">{{ rate(e.edge.requestRate) }}</text>
        }
        @for (n of placed; track n.id) {
          <g class="node" [class.own]="!n.external && !n.virtual" [class.external]="n.external" [attr.transform]="'translate(' + (n.x - 70) + ',' + (n.y - 18) + ')'" (click)="selectService.emit(n.id)" role="button" [attr.aria-label]="n.id">
            <rect width="140" height="36"></rect>
            <text x="70" y="16" text-anchor="middle">{{ short(n.id) }}</text>
            <text class="sub" x="70" y="29" text-anchor="middle">{{ n.external ? 'other project' : n.virtual ? 'dependency' : 'service' }}</text>
          </g>
        }
      </svg>
    }
  `,
})
export class ObsServiceMapComponent implements OnChanges {
  @Input() nodes: GraphNode[] = [];
  @Input() edges: GraphEdge[] = [];
  @Output() selectService = new EventEmitter<string>();

  placed: PlacedNode[] = [];
  placedEdges: Array<{ key: string; edge: GraphEdge; d: string; mx: number; my: number }> = [];
  width = 300;
  height = 120;
  readonly rate = fmtRate;
  readonly pct = fmtPct;

  ngOnChanges(): void {
    const g = layoutGraph(this.nodes, this.edges);
    this.placed = g.nodes;
    this.width = g.width;
    this.height = g.height;
    const at = new Map(g.nodes.map((n) => [n.id, n]));
    this.placedEdges = this.edges.flatMap((e) => {
      const a = at.get(e.source);
      const b = at.get(e.target);
      if (!a || !b) return [];
      const x1 = a.x + 70, y1 = a.y, x2 = b.x - 70, y2 = b.y;
      const self = a.id === b.id;
      const d = self ? `M${a.x + 40},${a.y - 18} c 30,-40 60,-10 30,18` : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
      return [{ key: `${e.source}\u0000${e.target}`, edge: e, d, mx: self ? a.x + 70 : (x1 + x2) / 2, my: self ? a.y - 34 : (y1 + y2) / 2 }];
    });
  }

  short(s: string): string {
    return s.length > 22 ? `${s.slice(0, 21)}…` : s;
  }
}
