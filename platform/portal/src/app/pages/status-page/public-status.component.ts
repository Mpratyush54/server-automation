import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { DatePipe, NgStyle } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';

export interface PublicDay {
  date: string;
  uptime: number | null;
  status: 'operational' | 'degraded' | 'outage' | 'unknown';
}

export interface PublicComponent {
  id: string;
  name: string;
  type: string;
  status: 'operational' | 'degraded' | 'outage' | 'unknown';
  lastCheckedAt: string | null;
  uptime: { '24h': number | null; '7d': number | null; '30d': number | null };
  avgLatencyMs24h: number | null;
  days: PublicDay[];
}

export interface PublicIncident {
  id: string;
  title: string;
  status: string;
  /** upcoming (maintenance before its window) | active | resolved (incl. window ended). */
  phase?: 'upcoming' | 'active' | 'resolved';
  impact: string;
  isMaintenance: boolean;
  updates: Array<{ at: string; status: string; body: string }>;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface PublicStatusPayload {
  slug: string;
  title: string;
  branding: { logoUrl: string | null; primaryColor: string | null; accentColor: string | null };
  generatedAt: string;
  status: 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'unknown';
  components: PublicComponent[];
  incidents: PublicIncident[];
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'operational': return 'All systems operational';
    case 'degraded': return 'Degraded performance';
    case 'partial_outage': return 'Partial outage';
    case 'major_outage': return 'Major outage';
    default: return 'Status unknown';
  }
}

/** Phase from the API, with a fallback for payloads that predate it. */
export function incidentPhase(inc: PublicIncident): 'upcoming' | 'active' | 'resolved' {
  return inc.phase || (inc.status === 'resolved' ? 'resolved' : 'active');
}

export function dayTitle(d: PublicDay): string {
  if (d.uptime === null) return `${d.date}: no data`;
  return `${d.date}: ${d.uptime}% (${d.status})`;
}

/**
 * Public unauthenticated status page (#46). Polls the cached public API so a
 * failing synthetic check appears within one check interval (cache TTL ≤ 15s).
 * Route: /status/:slug
 */
@Component({
  selector: 'app-public-status',
  standalone: true,
  imports: [DatePipe, NgStyle],
  templateUrl: './public-status.component.html',
  styleUrl: './public-status.component.css',
})
export class PublicStatusComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);

  slug = '';
  payload: PublicStatusPayload | null = null;
  error = '';
  loading = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly statusLabel = statusLabel;
  readonly dayTitle = dayTitle;

  ngOnInit(): void {
    this.slug = this.route.snapshot.paramMap.get('slug') || '';
    void this.load();
    this.timer = setInterval(() => void this.load(true), 20_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async load(silent = false): Promise<void> {
    if (!silent) this.loading = true;
    try {
      this.payload = await firstValueFrom(
        this.http.get<PublicStatusPayload>(`/api/public/status/${encodeURIComponent(this.slug)}`),
      );
      this.error = '';
    } catch (err: any) {
      if (!silent) {
        this.payload = null;
        this.error = err?.status === 404
          ? 'This status page is not published.'
          : (err?.error?.error || err?.message || 'Unable to load status');
      }
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  openIncidents(): PublicIncident[] {
    return (this.payload?.incidents || []).filter((i) => incidentPhase(i) === 'active');
  }

  upcomingMaintenance(): PublicIncident[] {
    return (this.payload?.incidents || [])
      .filter((i) => incidentPhase(i) === 'upcoming')
      .sort((a, b) => String(a.scheduledStart || '').localeCompare(String(b.scheduledStart || '')));
  }

  pastIncidents(): PublicIncident[] {
    return (this.payload?.incidents || []).filter((i) => incidentPhase(i) === 'resolved');
  }

  cssVars(): Record<string, string> {
    const b = this.payload?.branding;
    return {
      '--sp-primary': b?.primaryColor || '#0f172a',
      '--sp-accent': b?.accentColor || '#16a34a',
    };
  }
}
