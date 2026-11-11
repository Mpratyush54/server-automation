import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

export interface StatusPageSettings {
  /** null until the first save creates the page. */
  id: string | null;
  projectId: string;
  slug: string;
  title: string;
  domain: string | null;
  published: boolean;
  branding: { logoUrl?: string | null; primaryColor?: string | null; accentColor?: string | null };
  componentIds: string[] | null;
  publicPath: string;
}

export interface StatusIncidentView {
  id: string;
  title: string;
  status: string;
  /** upcoming (maintenance before its window) | active | resolved (incl. window ended). */
  phase?: 'upcoming' | 'active' | 'resolved';
  impact: string;
  isMaintenance: boolean;
  updates: Array<{ at: string; status: string; body: string }>;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyntheticCheckOption {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config?: { statusPage?: { visible?: boolean; name?: string } };
}

/** Display name for a check on the status page (mirrors #42 feed naming). */
export function componentLabel(c: SyntheticCheckOption): string {
  return String(c.config?.statusPage?.name || c.name);
}

/** Lifecycle statuses an operator can post as an update. */
export const UPDATE_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;

/** `<input type="datetime-local">` value (local time) → ISO string, or null when empty/invalid. */
export function localInputToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Editor label for where an incident sits on the timeline. */
export function phaseLabel(inc: Pick<StatusIncidentView, 'phase' | 'status' | 'isMaintenance'>): string {
  if (inc.phase === 'upcoming') return 'upcoming';
  if (inc.phase === 'resolved' && inc.status !== 'resolved') return 'completed (window ended)';
  if (inc.isMaintenance && inc.phase === 'active' && inc.status !== 'resolved') return 'in progress';
  return '';
}

/** Whether the editor should still offer updates/resolve for this incident. */
export function isOpenIncident(inc: Pick<StatusIncidentView, 'status'>): boolean {
  return inc.status !== 'resolved';
}

/**
 * Project status-page editor (#46): publish toggle, slug/branding, component
 * selection (mapped to synthetic checks), and incident / maintenance notes.
 * Route: /projects/:id/status
 */
@Component({
  selector: 'app-status-page-editor',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink],
  templateUrl: './status-page-editor.component.html',
  styleUrl: './status-page-editor.component.css',
})
export class StatusPageEditorComponent implements OnInit {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);

  projectId = '';
  page: StatusPageSettings | null = null;
  checks: SyntheticCheckOption[] = [];
  incidents: StatusIncidentView[] = [];
  selectedIds = new Set<string>();
  useAllComponents = true;

  error = '';
  notice = '';
  busy = false;

  draftIncident = {
    title: '',
    impact: 'minor',
    status: 'investigating',
    isMaintenance: false,
    body: '',
    scheduledStart: '',
    scheduledEnd: '',
  };

  /** Per-incident "post update" drafts, keyed by incident id. */
  updateDrafts: Record<string, { status: string; body: string }> = {};

  readonly componentLabel = componentLabel;
  readonly phaseLabel = phaseLabel;
  readonly isOpenIncident = isOpenIncident;
  readonly updateStatuses = UPDATE_STATUSES;

  async ngOnInit(): Promise<void> {
    this.projectId = this.route.snapshot.paramMap.get('id') || '';
    await this.reload();
  }

  async reload(): Promise<void> {
    this.error = '';
    try {
      const [page, checksRes, incidentsRes] = await Promise.all([
        firstValueFrom(this.http.get<StatusPageSettings>(`/api/projects/${this.projectId}/status-page`)),
        firstValueFrom(this.http.get<{ checks: SyntheticCheckOption[] }>(`/api/projects/${this.projectId}/synthetics/checks`)).catch(() => ({ checks: [] as SyntheticCheckOption[] })),
        firstValueFrom(this.http.get<{ incidents: StatusIncidentView[] }>(`/api/projects/${this.projectId}/status-page/incidents`)),
      ]);
      this.page = {
        ...page,
        branding: {
          logoUrl: page.branding?.logoUrl ?? null,
          primaryColor: page.branding?.primaryColor ?? null,
          accentColor: page.branding?.accentColor ?? null,
        },
      };
      this.checks = checksRes.checks || [];
      this.incidents = incidentsRes.incidents || [];
      const drafts: Record<string, { status: string; body: string }> = {};
      for (const inc of this.incidents) {
        drafts[inc.id] = this.updateDrafts[inc.id] || {
          status: inc.status === 'scheduled' ? 'monitoring' : inc.status,
          body: '',
        };
      }
      this.updateDrafts = drafts;
      this.useAllComponents = page.componentIds === null;
      this.selectedIds = new Set(page.componentIds || []);
    } catch (err: any) {
      this.error = err?.error?.error || err?.message || 'Failed to load status page';
    }
    this.cdr.markForCheck();
  }

  toggleCheck(id: string, on: boolean): void {
    if (on) this.selectedIds.add(id);
    else this.selectedIds.delete(id);
  }

  isSelected(id: string): boolean {
    return this.selectedIds.has(id);
  }

  async save(): Promise<void> {
    if (!this.page) return;
    this.busy = true;
    this.error = '';
    this.notice = '';
    try {
      const body = {
        slug: this.page.slug.trim().toLowerCase(),
        title: this.page.title.trim(),
        domain: this.page.domain?.trim() || null,
        published: this.page.published,
        branding: {
          logoUrl: this.page.branding?.logoUrl || null,
          primaryColor: this.page.branding?.primaryColor || null,
          accentColor: this.page.branding?.accentColor || null,
        },
        componentIds: this.useAllComponents ? null : [...this.selectedIds],
      };
      this.page = await firstValueFrom(
        this.http.put<StatusPageSettings>(`/api/projects/${this.projectId}/status-page`, body),
      );
      this.notice = this.page.published
        ? `Published at ${this.page.publicPath}`
        : 'Saved (not published)';
    } catch (err: any) {
      this.error = err?.error?.error || err?.message || 'Save failed';
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  async createIncident(): Promise<void> {
    if (!this.draftIncident.title.trim()) return;
    const maint = this.draftIncident.isMaintenance;
    const scheduledStart = maint ? localInputToIso(this.draftIncident.scheduledStart) : null;
    const scheduledEnd = maint ? localInputToIso(this.draftIncident.scheduledEnd) : null;
    if (scheduledStart && scheduledEnd && scheduledEnd <= scheduledStart) {
      this.error = 'Maintenance end must be after its start';
      this.cdr.markForCheck();
      return;
    }
    this.busy = true;
    this.error = '';
    try {
      await firstValueFrom(
        this.http.post(`/api/projects/${this.projectId}/status-page/incidents`, {
          title: this.draftIncident.title.trim(),
          impact: this.draftIncident.impact,
          status: maint ? 'scheduled' : this.draftIncident.status,
          isMaintenance: maint,
          body: this.draftIncident.body.trim() || undefined,
          scheduledStart: scheduledStart || undefined,
          scheduledEnd: scheduledEnd || undefined,
        }),
      );
      this.draftIncident = {
        title: '', impact: 'minor', status: 'investigating', isMaintenance: false, body: '',
        scheduledStart: '', scheduledEnd: '',
      };
      await this.reload();
      this.notice = 'Incident created';
    } catch (err: any) {
      this.error = err?.error?.error || err?.message || 'Failed to create incident';
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  async resolveIncident(inc: StatusIncidentView): Promise<void> {
    this.busy = true;
    this.error = '';
    try {
      await firstValueFrom(
        this.http.post(`/api/projects/${this.projectId}/status-page/incidents/${inc.id}/updates`, {
          status: 'resolved',
          body: 'Resolved',
        }),
      );
      await this.reload();
    } catch (err: any) {
      this.error = err?.error?.error || err?.message || 'Failed to resolve';
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  async postUpdate(inc: StatusIncidentView): Promise<void> {
    const draft = this.updateDrafts[inc.id];
    if (!draft || !draft.body.trim()) return;
    this.busy = true;
    this.error = '';
    try {
      await firstValueFrom(
        this.http.post(`/api/projects/${this.projectId}/status-page/incidents/${inc.id}/updates`, {
          status: draft.status,
          body: draft.body.trim(),
        }),
      );
      delete this.updateDrafts[inc.id];
      await this.reload();
      this.notice = 'Update posted';
    } catch (err: any) {
      this.error = err?.error?.error || err?.message || 'Failed to post update';
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  async deleteIncident(inc: StatusIncidentView): Promise<void> {
    if (!confirm(`Delete incident "${inc.title}"?`)) return;
    this.busy = true;
    try {
      await firstValueFrom(
        this.http.delete(`/api/projects/${this.projectId}/status-page/incidents/${inc.id}`),
      );
      await this.reload();
    } catch (err: any) {
      this.error = err?.error?.error || err?.message || 'Failed to delete';
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}
