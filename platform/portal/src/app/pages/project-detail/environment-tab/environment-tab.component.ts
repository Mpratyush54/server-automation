import { Component, Input, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../services/api.service';
import { StepUpService } from '../../../services/step-up.service';

/** One merged row from GET /projects/:id/environment (#29). */
export interface EnvVarRow {
  key: string;
  type: 'plain' | 'secret';
  value: string | null;
  masked: boolean;
  environmentId: string | null;
  scope: 'global' | 'environment';
  version: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
  secretId: string | null;
  conflict: boolean;
  legacyMasked?: boolean;
  /** UI only: value returned by the reveal endpoint. */
  revealed?: string | null;
}

export interface EnvCapabilities {
  canReadValues: boolean;
  canReveal: boolean;
  canWritePlain: boolean;
  canWriteSecret: boolean;
  canDeletePlain: boolean;
  canDeleteSecret: boolean;
  canImport: boolean;
  canExport: boolean;
  canViewHistory: boolean;
  canRollback: boolean;
}

export interface BulkLine { key: string; value: string; secret: boolean; valid: boolean }

const NO_CAPS: EnvCapabilities = {
  canReadValues: false, canReveal: false, canWritePlain: false, canWriteSecret: false, canDeletePlain: false,
  canDeleteSecret: false, canImport: false, canExport: false, canViewHistory: false, canRollback: false,
};
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/;
const SECRETISH = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|_KEY$|DSN|DATABASE_URL)/i;

/** Parse `.env` text: skips blanks/comments, strips `export ` and matching quotes; secret-looking keys default to secret. */
export function parseDotEnv(text: string): BulkLine[] {
  const out: BulkLine[] = [];
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out.push({ key, value, secret: SECRETISH.test(key), valid: KEY_RE.test(key) });
  }
  return out;
}

@Component({
  selector: 'app-environment-tab',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
<div class="env-tab">
  <div class="card env-toolbar">
    <div class="env-toolbar-row">
      <div class="form-group env-field">
        <label for="envScope">Environment</label>
        <select id="envScope" [(ngModel)]="selectedEnv" (ngModelChange)="load()">
          <option value="__all">All scopes</option>
          <option value="global">Global only</option>
          @for (env of environments; track env.id) {
            <option [value]="env.id">{{ env.name | uppercase }} (incl. global)</option>
          }
        </select>
      </div>
      <div class="form-group env-field env-grow">
        <label for="envSearch">Search</label>
        <input id="envSearch" [(ngModel)]="search" placeholder="Filter by key…" autocomplete="off">
      </div>
      <div class="env-actions">
        @if (canWriteAny) {
          <button class="btn btn-sm btn-primary" (click)="openForm()">+ Add variable</button>
          <button class="btn btn-sm" (click)="openBulk()">Paste .env</button>
        }
        @if (caps.canExport && selectedEnvId) {
          <button class="btn btn-sm" (click)="exportSecrets()">Export secrets</button>
        }
      </div>
    </div>
    @if (conflicts > 0) {
      <p class="env-warn" role="alert">
        {{ conflicts / 2 }} key(s) are stored as both plain and secret in the same scope. Resolve each conflict by keeping one.
      </p>
    }
    @if (!caps.canReadValues) {
      <p class="env-muted">You can see keys and types only.</p>
    }
  </div>

  @if (showForm) {
    <div class="card env-form" aria-label="Add or edit variable">
      <h2>{{ editing ? 'Edit' : 'Add' }} variable</h2>
      <div class="env-form-grid">
        <div class="form-group">
          <label for="envKey">Key</label>
          <input id="envKey" [(ngModel)]="form.key" [readonly]="!!editing" placeholder="API_URL" autocomplete="off">
          @if (form.key && !keyValid(form.key)) {
            <small class="env-error">Letters, digits, _ . - ; must start with a letter or _</small>
          }
        </div>
        <div class="form-group">
          <label for="envFormScope">Scope</label>
          <select id="envFormScope" [(ngModel)]="form.environmentId" [disabled]="!!editing">
            <option value="">Global (all environments)</option>
            @for (env of environments; track env.id) {
              <option [value]="env.id">{{ env.name | uppercase }}</option>
            }
          </select>
        </div>
      </div>
      <div class="form-group">
        <label for="envValue">Value</label>
        <textarea id="envValue" [(ngModel)]="form.value" rows="3"
          [placeholder]="editing ? 'Leave empty to keep the current value' : ''"></textarea>
      </div>
      <label class="env-toggle">
        <input type="checkbox" [(ngModel)]="form.secret" [disabled]="!caps.canWriteSecret || !caps.canWritePlain">
        <span>Encrypt as secret</span>
      </label>
      @if (editing && editing.type === 'plain' && form.secret) {
        <p class="env-muted">The plain value will be moved into the encrypted store and removed from config storage.</p>
      }
      @if (editing && editing.type === 'secret' && !form.secret) {
        <p class="env-warn">This stores the value in plaintext. You will be asked to confirm with your authenticator.</p>
      }
      <div class="env-form-actions">
        <button class="btn btn-sm btn-primary" (click)="save()" [disabled]="!canSave() || busy">Save</button>
        <button class="btn btn-sm" (click)="closeForm()">Cancel</button>
      </div>
    </div>
  }

  @if (showBulk) {
    <div class="card env-form" aria-label="Bulk paste">
      <h2>Paste .env</h2>
      <div class="form-group">
        <label for="bulkScope">Scope</label>
        <select id="bulkScope" [(ngModel)]="bulkEnvId">
          <option value="">Global (all environments)</option>
          @for (env of environments; track env.id) {
            <option [value]="env.id">{{ env.name | uppercase }}</option>
          }
        </select>
      </div>
      <div class="form-group">
        <label for="bulkText">KEY=VALUE lines</label>
        <textarea id="bulkText" [(ngModel)]="bulkText" (ngModelChange)="parseBulk()" rows="6" class="env-mono"
          placeholder="API_URL=https://api.example.test&#10;DB_PASSWORD=..."></textarea>
      </div>
      @if (bulkLines.length) {
        <table class="env-table">
          <thead><tr><th>Key</th><th>Secret</th><th></th></tr></thead>
          <tbody>
            @for (l of bulkLines; track $index) {
              <tr>
                <td class="env-mono">{{ l.key }}</td>
                <td><input type="checkbox" [(ngModel)]="l.secret" [attr.aria-label]="'Secret ' + l.key" class="env-check"></td>
                <td>@if (!l.valid) { <span class="badge badge-failed">invalid key</span> }</td>
              </tr>
            }
          </tbody>
        </table>
      }
      <div class="env-form-actions">
        <button class="btn btn-sm btn-primary" (click)="importBulk()" [disabled]="!validBulkLines().length || busy">
          Import {{ validBulkLines().length }} variable(s)
        </button>
        <button class="btn btn-sm" (click)="showBulk = false">Cancel</button>
      </div>
    </div>
  }

  @if (exportText !== null) {
    <div class="card env-form">
      <h2>Exported secrets</h2>
      <textarea readonly [value]="exportText" rows="8" class="env-mono"></textarea>
      <div class="env-form-actions">
        <button class="btn btn-sm" (click)="copy(exportText)">Copy</button>
        <button class="btn btn-sm" (click)="exportText = null">Close</button>
      </div>
    </div>
  }

  <div class="card">
    <h2>Variables</h2>
    @if (error) { <p class="env-error">{{ error }}</p> }
    <div class="env-scroll">
      <table class="env-table">
        <thead>
          <tr><th>Key</th><th>Type</th><th>Scope</th><th>Value</th><th>Last changed</th><th>Actions</th></tr>
        </thead>
        <tbody>
          @for (row of filtered(); track rowId(row)) {
            <tr [class.env-conflict-row]="row.conflict">
              <td class="env-mono env-key">
                {{ row.key }}
                @if (row.conflict) { <span class="badge badge-failed" title="Stored as both plain and secret">conflict</span> }
              </td>
              <td>
                <span class="badge" [class.env-badge-secret]="row.type === 'secret'" [class.badge-active]="row.type === 'plain'">{{ row.type }}</span>
                @if (row.legacyMasked) { <span class="badge badge-pending" title="Legacy masked config value stored in plaintext">legacy</span> }
              </td>
              <td><span class="env-muted">{{ envName(row.environmentId) }}</span></td>
              <td class="env-mono env-value">
                @if (row.type === 'secret') {
                  @if (row.revealed != null) { <span class="env-revealed">{{ row.revealed }}</span> } @else { <span aria-label="masked">••••••••</span> }
                } @else if (row.masked) {
                  <span class="env-muted" aria-label="hidden">hidden</span>
                } @else {
                  {{ row.value }}
                }
              </td>
              <td class="env-muted env-small">
                {{ row.updatedAt ? (row.updatedAt | date:'short') : '—' }}
                @if (row.updatedBy) { <br>{{ row.updatedBy }} }
                @if (row.version) { <br>v{{ row.version }} }
              </td>
              <td>
                <div class="env-row-actions">
                  @if (copyable(row)) {
                    <button class="btn btn-sm" (click)="copy(row.type === 'secret' ? row.revealed! : row.value!)">Copy</button>
                  }
                  @if (row.type === 'secret' && caps.canReveal) {
                    @if (row.revealed == null) {
                      <button class="btn btn-sm" (click)="reveal(row)">Reveal</button>
                    } @else {
                      <button class="btn btn-sm" (click)="row.revealed = null">Hide</button>
                    }
                  }
                  @if (canEdit(row)) {
                    <button class="btn btn-sm" (click)="openForm(row)">Edit</button>
                  }
                  @if (row.type === 'secret' && row.secretId && caps.canViewHistory) {
                    <button class="btn btn-sm" (click)="openHistory(row)">History</button>
                  }
                  @if (row.conflict) {
                    @if (row.type === 'secret' && caps.canDeletePlain) {
                      <button class="btn btn-sm btn-primary" (click)="remove(row, 'plain')">Keep secret</button>
                    }
                    @if (row.type === 'plain' && caps.canDeleteSecret) {
                      <button class="btn btn-sm" (click)="remove(row, 'secret')">Keep plain</button>
                    }
                  } @else if (canDelete(row)) {
                    <button class="btn btn-sm btn-danger" (click)="remove(row, row.type)">Delete</button>
                  }
                </div>
              </td>
            </tr>
          }
          @if (!loading && filtered().length === 0) {
            <tr><td colspan="6" class="env-empty">No variables{{ search ? ' match "' + search + '"' : '' }}</td></tr>
          }
        </tbody>
      </table>
    </div>
  </div>

  @if (history) {
    <div class="env-drawer-backdrop" (click)="history = null"></div>
    <aside class="env-drawer" role="dialog" aria-label="Version history">
      <div class="env-drawer-head">
        <h2>History: <span class="env-mono">{{ history.row.key }}</span></h2>
        <button class="btn btn-sm" (click)="history = null" aria-label="Close">✕</button>
      </div>
      <p class="env-muted">Current version v{{ history.currentVersion }} · {{ envName(history.row.environmentId) }}</p>
      <table class="env-table">
        <thead><tr><th>Version</th><th>Changed</th><th></th></tr></thead>
        <tbody>
          @for (v of history.versions; track v.version) {
            <tr>
              <td>v{{ v.version }}</td>
              <td class="env-small env-muted">{{ v.changedAt | date:'short' }}</td>
              <td>@if (caps.canRollback) { <button class="btn btn-sm" (click)="rollback(v.version)">Rollback</button> }</td>
            </tr>
          }
          @if (!history.versions.length) {
            <tr><td colspan="3" class="env-empty">No previous versions</td></tr>
          }
        </tbody>
      </table>
    </aside>
  }
</div>
`,
  styles: [`
.env-tab { display: flex; flex-direction: column; gap: 20px; }
.env-toolbar-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
.env-field { margin-bottom: 0; min-width: 200px; }
.env-grow { flex: 1; }
.env-actions, .env-row-actions, .env-form-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.env-form-actions { margin-top: 12px; }
.env-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.env-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--text-primary, #ededed); font-size: 0.875rem; }
.env-toggle input, .env-check { width: auto; }
.env-mono { font-family: var(--font-code, monospace); }
.env-key { font-weight: 600; word-break: break-all; }
.env-value { max-width: 360px; word-break: break-all; }
.env-revealed { color: var(--accent-success, #0070F3); font-weight: 600; }
.env-muted { color: var(--text-muted, #71717a); font-size: 0.8rem; margin: 8px 0 0; }
.env-small { font-size: 0.75rem; line-height: 1.3; }
.env-warn { color: var(--accent-warning, #F5A623); font-size: 0.8rem; margin: 10px 0 0; }
.env-error { color: var(--accent-danger, #E00000); font-size: 0.8rem; }
.env-empty { text-align: center; color: var(--text-muted, #71717a); }
.env-scroll { overflow-x: auto; }
.env-conflict-row td { background: color-mix(in srgb, var(--accent-danger, #E00000) 6%, transparent); }
.env-badge-secret { background: color-mix(in srgb, #a855f7 12%, transparent); color: #c084fc; border-color: color-mix(in srgb, #a855f7 30%, transparent); }
.env-drawer-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 998; }
.env-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(440px, 100%); z-index: 999; overflow-y: auto;
  background: var(--bg-surface, #0a0a0a); border-left: 1px solid var(--border-subtle, #333); padding: 20px; color: var(--text-primary, #ededed); }
.env-drawer-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.env-drawer-head h2 { margin: 0; border: 0; padding: 0; font-size: 1rem; }
@media (prefers-color-scheme: light) {
  .env-badge-secret { color: #7e22ce; }
  .env-drawer-backdrop { background: rgba(0, 0, 0, 0.25); }
}
`],
})
export class EnvironmentTabComponent implements OnChanges {
  @Input({ required: true }) projectId!: string;
  @Input() environments: { id: string; name: string }[] = [];

  private api = inject(ApiService);
  private stepUp = inject(StepUpService);

  rows: EnvVarRow[] = [];
  caps: EnvCapabilities = { ...NO_CAPS };
  conflicts = 0;
  selectedEnv = '__all';
  search = '';
  loading = false;
  busy = false;
  error = '';

  showForm = false;
  editing: EnvVarRow | null = null;
  form = { key: '', value: '', environmentId: '', secret: true };

  showBulk = false;
  bulkText = '';
  bulkEnvId = '';
  bulkLines: BulkLine[] = [];

  exportText: string | null = null;
  history: { row: EnvVarRow; currentVersion: number; versions: { version: number; changedAt: string }[] } | null = null;

  ngOnChanges(changes: SimpleChanges) {
    if (changes['projectId'] && this.projectId) this.load();
  }

  get canWriteAny(): boolean { return this.caps.canWritePlain || this.caps.canWriteSecret; }
  /** Specific environment id when one is selected (export, defaults for new rows). */
  get selectedEnvId(): string { return this.selectedEnv !== '__all' && this.selectedEnv !== 'global' ? this.selectedEnv : ''; }

  async load() {
    if (!this.projectId) return;
    this.loading = true;
    this.error = '';
    try {
      const envParam = this.selectedEnv === '__all' ? undefined : this.selectedEnv;
      const res: any = await firstValueFrom(this.api.getEnvironmentVars(this.projectId, envParam));
      this.rows = (res?.variables || []) as EnvVarRow[];
      this.caps = { ...NO_CAPS, ...(res?.capabilities || {}) };
      this.conflicts = res?.conflicts || 0;
    } catch (err: any) {
      this.rows = [];
      this.error = 'Failed to load variables: ' + (err?.error?.error || err?.message || 'unknown error');
    } finally {
      this.loading = false;
    }
  }

  filtered(): EnvVarRow[] {
    const q = this.search.trim().toLowerCase();
    return q ? this.rows.filter((r) => r.key.toLowerCase().includes(q)) : this.rows;
  }

  rowId(r: EnvVarRow): string { return `${r.type}:${r.environmentId || ''}:${r.key}`; }

  envName(id: string | null): string {
    if (!id) return 'Global';
    const env = this.environments.find((e) => e.id === id || e.name === id);
    return env ? env.name.toUpperCase() : id;
  }

  keyValid(k: string): boolean { return KEY_RE.test(k); }

  copyable(row: EnvVarRow): boolean {
    return row.type === 'secret' ? row.revealed != null : !row.masked && row.value != null;
  }

  canEdit(row: EnvVarRow): boolean {
    return row.type === 'secret' ? this.caps.canWriteSecret : this.caps.canWritePlain;
  }

  canDelete(row: EnvVarRow): boolean {
    return row.type === 'secret' ? this.caps.canDeleteSecret : this.caps.canDeletePlain;
  }

  async copy(text: string | null) {
    if (text == null) return;
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }
  }

  async reveal(row: EnvVarRow) {
    try {
      // Existing endpoint: secrets.reveal permission, MFA step-up and the secrets.reveal audit entry.
      const res: any = await this.stepUp.run(
        () => firstValueFrom(this.api.revealSecret(this.projectId, { environmentId: row.environmentId, key: row.key })),
        `Reveal ${row.key}`,
      );
      row.revealed = res?.value ?? '';
    } catch (err: any) {
      alert('Failed to reveal: ' + (err?.error?.error || err?.message));
    }
  }

  openForm(row?: EnvVarRow) {
    this.showBulk = false;
    this.editing = row || null;
    this.form = row
      ? { key: row.key, value: row.type === 'plain' && !row.masked ? (row.value || '') : '', environmentId: row.environmentId || '', secret: row.type === 'secret' }
      : { key: '', value: '', environmentId: this.selectedEnvId, secret: this.caps.canWriteSecret };
    if (!this.caps.canWriteSecret) this.form.secret = false;
    if (!this.caps.canWritePlain) this.form.secret = true;
    this.showForm = true;
  }

  closeForm() { this.showForm = false; this.editing = null; }

  canSave(): boolean {
    if (!this.keyValid(this.form.key)) return false;
    if (this.form.value !== '') return true;
    // Empty value is only allowed for a pure type change of an existing row (server keeps the value).
    return !!this.editing && (this.editing.type === 'secret') !== this.form.secret;
  }

  async save() {
    if (!this.canSave()) return;
    this.busy = true;
    try {
      const body: { environmentId: string | null; value?: string; secret: boolean } = {
        environmentId: this.form.environmentId || null,
        secret: this.form.secret,
      };
      if (this.form.value !== '') body.value = this.form.value;
      // secret → plain answers 401 step_up_required: confirm with a code and retry once.
      await this.stepUp.run(() => firstValueFrom(this.api.setEnvironmentVar(this.projectId, this.form.key, body)),
        `Store ${this.form.key} as plain text`);
      this.closeForm();
      await this.load();
    } catch (err: any) {
      alert('Failed to save: ' + (err?.error?.error || err?.message));
    } finally {
      this.busy = false;
    }
  }

  async remove(row: EnvVarRow, type: 'plain' | 'secret') {
    const what = row.conflict ? `the ${type} copy of "${row.key}"` : `"${row.key}"`;
    if (!confirm(`Delete ${what} (${this.envName(row.environmentId)})?`)) return;
    try {
      await firstValueFrom(this.api.deleteEnvironmentVar(this.projectId, row.key, type, row.environmentId));
      await this.load();
    } catch (err: any) {
      alert('Failed to delete: ' + (err?.error?.error || err?.message));
    }
  }

  openBulk() {
    this.showForm = false;
    this.bulkText = '';
    this.bulkLines = [];
    this.bulkEnvId = this.selectedEnvId;
    this.showBulk = true;
  }

  parseBulk() {
    const prev = new Map(this.bulkLines.map((l) => [l.key, l.secret]));
    this.bulkLines = parseDotEnv(this.bulkText).map((l) => ({ ...l, secret: prev.has(l.key) ? prev.get(l.key)! : l.secret }));
    if (!this.caps.canWriteSecret) this.bulkLines.forEach((l) => (l.secret = false));
    if (!this.caps.canWritePlain) this.bulkLines.forEach((l) => (l.secret = true));
  }

  validBulkLines(): BulkLine[] { return this.bulkLines.filter((l) => l.valid); }

  /**
   * New secrets go through POST /secrets/bulk in one call. Lines that change a key's type in this
   * scope (plain ↔ secret) and plain lines use PUT /environment/:key so the other copy is removed.
   */
  async importBulk() {
    const lines = this.validBulkLines();
    if (!lines.length) return;
    this.busy = true;
    const environmentId = this.bulkEnvId || null;
    try {
      const res: any = await firstValueFrom(this.api.getEnvironmentVars(this.projectId, environmentId || 'global'));
      const existing: EnvVarRow[] = (res?.variables || []).filter((r: EnvVarRow) => (r.environmentId || null) === environmentId);
      const plainKeys = new Set(existing.filter((r) => r.type === 'plain').map((r) => r.key));
      const viaBulk = lines.filter((l) => l.secret && !plainKeys.has(l.key));
      const viaPut = lines.filter((l) => !viaBulk.includes(l));
      if (viaBulk.length) {
        await firstValueFrom(this.api.bulkImportSecrets(this.projectId, {
          environmentId,
          secrets: viaBulk.map((l) => ({ key: l.key, value: l.value })),
        }));
      }
      for (const l of viaPut) {
        await this.stepUp.run(() => firstValueFrom(this.api.setEnvironmentVar(this.projectId, l.key, { environmentId, value: l.value, secret: l.secret })),
          `Store ${l.key} as plain text`);
      }
      this.showBulk = false;
      this.bulkText = '';
      this.bulkLines = [];
      await this.load();
    } catch (err: any) {
      alert('Import failed: ' + (err?.error?.error || err?.message));
      await this.load();
    } finally {
      this.busy = false;
    }
  }

  async exportSecrets() {
    const envId = this.selectedEnvId;
    if (!envId) return;
    try {
      const res: any = await this.stepUp.run(() => firstValueFrom(this.api.exportSecrets(this.projectId, envId)), 'Export secrets');
      this.exportText = res?.secrets ?? '';
    } catch (err: any) {
      alert('Failed to export: ' + (err?.error?.error || err?.message));
    }
  }

  async openHistory(row: EnvVarRow) {
    if (!row.secretId) return;
    try {
      const res: any = await firstValueFrom(this.api.getSecretVersions(this.projectId, row.secretId));
      this.history = { row, currentVersion: res?.currentVersion ?? row.version ?? 1, versions: res?.history || [] };
    } catch (err: any) {
      alert('Failed to load history: ' + (err?.error?.error || err?.message));
    }
  }

  async rollback(version: number) {
    const h = this.history;
    if (!h?.row.secretId) return;
    if (!confirm(`Roll back "${h.row.key}" to version ${version}?`)) return;
    try {
      await firstValueFrom(this.api.rollbackSecret(this.projectId, h.row.secretId, version));
      this.history = null;
      await this.load();
    } catch (err: any) {
      alert('Rollback failed: ' + (err?.error?.error || err?.message));
    }
  }
}
