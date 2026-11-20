import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';
import { DialogService, ToastService } from '../../shared/feedback/feedback.service';
import { AirgapStoryComponent } from './airgap-story.component';
import {
  AccountInfo, AccountInstall, AccountKey, DiagnosticsReport, LicenseAccountService, PRIVACY_EMAIL,
} from './license-account.service';

/** In-page sections, in order (ids are URL fragments). */
export const ACCOUNT_SECTIONS = [
  { id: 'keys', label: 'Keys' },
  { id: 'installs', label: 'Installs' },
  { id: 'offline', label: 'Without internet' },
  { id: 'data', label: 'Your data' },
  { id: 'delete', label: 'Delete account' },
] as const;

/** Diagnostics reports of one install, as shown under "Your data". */
export interface ReportsState {
  status: 'loading' | 'ready' | 'error';
  reports: DiagnosticsReport[];
  truncated: boolean;
  error: string;
}

const KIND_LABELS: Record<string, string> = {
  provision: 'Installation',
  update: 'Update',
  upgrade: 'Upgrade',
  join: 'Server joined',
  periodic: 'Weekly check-in',
  error: 'Install step failed',
};

const COMPONENT_STATUS: Record<string, string> = { healthy: 'status-ok', degraded: 'status-warn', down: 'status-down' };

/** Human label for a diagnostics report kind. */
export function reportKindLabel(kind: string | undefined): string {
  if (!kind) return 'Report';
  return KIND_LABELS[kind] || kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Short duration such as "42 s", "3 min 5 s" or "2 h 10 min". */
export function formatDuration(seconds: number | undefined | null): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds * 10) / 10} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${Math.round(seconds % 60)} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

@Component({
  selector: 'app-account',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterModule, SiteHeaderComponent, SiteFooterComponent, AirgapStoryComponent],
  styleUrls: ['./site-page.css', './account.component.css'],
  templateUrl: './account.component.html',
})
export class AccountComponent implements OnInit {
  private api = inject(LicenseAccountService);
  private router = inject(Router);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  readonly privacyEmail = PRIVACY_EMAIL;
  readonly kindLabel = reportKindLabel;
  readonly duration = formatDuration;
  readonly sections = ACCOUNT_SECTIONS;
  loading = true;
  busy = false;
  exporting = false;
  error = '';
  account: AccountInfo = {};
  keys: AccountKey[] = [];
  installs: AccountInstall[] = [];
  reports: Record<string, ReportsState> = {};
  /** Settles when the diagnostics reports requested by the last refresh have loaded. */
  reportsLoaded: Promise<void> = Promise.resolve();
  newKey = '';
  offlineKey = '';
  offlineRequest = '';
  deletePassword = '';
  /** Replaced in tests. */
  download = (filename: string, content: string) => {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  get email() { return this.account.email || ''; }
  get activeKeys() { return this.keys.filter(k => !k.revoked); }
  get activeInstalls() { return this.installs.filter(i => i.active !== false); }

  async ngOnInit() {
    try {
      const res = await this.api.account();
      this.account = res?.account || {};
      await this.refresh();
    } catch (e: any) {
      if (e?.status === 401) {
        await this.router.navigateByUrl('/signin');
        return;
      }
      this.error = e?.message || 'Could not load your account.';
    } finally {
      this.loading = false;
    }
  }

  async refresh() {
    const [k, i] = await Promise.all([this.api.keys(), this.api.installs()]);
    this.keys = k?.keys || [];
    this.installs = i?.installs || [];
    if (!this.offlineKey && this.activeKeys.length) this.offlineKey = this.activeKeys[0].id;
    // Installs may have changed: reload their reports in the background.
    this.reports = {};
    this.reportsLoaded = this.loadReports();
  }

  /** Loads the diagnostics reports of every install not loaded yet (or that failed). */
  async loadReports() {
    const todo = this.installs.filter(i => !this.reports[i.id] || this.reports[i.id].status === 'error');
    await Promise.all(todo.map(i => this.loadInstallReports(i.id)));
  }

  async loadInstallReports(id: string) {
    this.reports[id] = { status: 'loading', reports: [], truncated: false, error: '' };
    try {
      const res = await this.api.installReports(id);
      this.reports[id] = { status: 'ready', reports: res?.reports || [], truncated: !!res?.truncated, error: '' };
    } catch (e: any) {
      this.reports[id] = { status: 'error', reports: [], truncated: false, error: e?.message || 'Could not load the reports.' };
    }
    // Reports arrive after the first render; make sure the view picks them up.
    this.cdr.markForCheck();
  }

  keyLabel(id: string | undefined) {
    const k = this.keys.find(x => x.id === id);
    return k ? `${this.planName(k)} · ${k.hint || k.id}` : (id || '');
  }

  planName(k: AccountKey) {
    const p = k.plan || 'license';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  limits(k: AccountKey) {
    const nodes = k.max_nodes ? `up to ${k.max_nodes} servers` : 'unlimited servers';
    const installs = k.max_installs ? `${k.max_installs} installs` : 'unlimited installs';
    return `${nodes}, ${installs}`;
  }

  servers(n: number | undefined) {
    const v = n || 1;
    return `${v} ${v === 1 ? 'server' : 'servers'}`;
  }

  componentStatus(status: string | undefined) {
    return COMPONENT_STATUS[status || ''] || 'status-info';
  }

  rawJson(r: DiagnosticsReport) {
    return JSON.stringify(r.payload, null, 2);
  }

  private async run(fn: () => Promise<void>, failure: string) {
    this.busy = true;
    this.error = '';
    try {
      await fn();
    } catch (e: any) {
      this.error = e?.message || failure;
    } finally {
      this.busy = false;
    }
  }

  async exportData() {
    this.exporting = true;
    try {
      const res = await this.api.exportData();
      this.download(res.filename, res.content);
      this.toast.show('Your data was downloaded', 'ok');
    } catch (e: any) {
      this.toast.error(e?.status === 429 ? 'Too many downloads. Try again in a minute.' : (e?.message || 'Could not download your data.'));
    } finally {
      this.exporting = false;
    }
  }

  createKey() {
    return this.run(async () => {
      const res = await this.api.createKey();
      this.newKey = res.license_key;
      await this.refresh();
    }, 'Could not create a key.');
  }

  async rotate(k: AccountKey) {
    const ok = await this.dialog.confirm({
      title: 'Rotate this key?', message: 'You get a new key and the old one stops working.', confirmLabel: 'Rotate',
    });
    if (!ok) return;
    await this.run(async () => {
      const res = await this.api.rotateKey(k.id);
      this.newKey = res.license_key;
      await this.refresh();
    }, 'Could not rotate the key.');
  }

  async revoke(k: AccountKey) {
    const ok = await this.dialog.confirm({ title: 'Revoke this key?', message: 'The key can no longer be used. This cannot be undone.', confirmLabel: 'Revoke', danger: true });
    if (!ok) return;
    await this.run(async () => {
      await this.api.revokeKey(k.id);
      this.toast.show('Key revoked', 'ok');
      await this.refresh();
    }, 'Could not revoke the key.');
  }

  async deactivate(i: AccountInstall) {
    const ok = await this.dialog.confirm({ title: 'Deactivate this install?', message: 'This frees a slot for another install.', confirmLabel: 'Deactivate', danger: true });
    if (!ok) return;
    await this.run(async () => {
      await this.api.deactivateInstall(i.id);
      this.toast.show('Install deactivated', 'ok');
      await this.refresh();
    }, 'Could not deactivate the install.');
  }

  offline() {
    return this.run(async () => {
      const res = await this.api.offline(this.offlineKey, this.offlineRequest.trim());
      this.download(res.filename || 'cairn-license.json', res.license_file);
      this.offlineRequest = '';
      this.toast.show('License file downloaded', 'ok');
      await this.refresh();
    }, 'Could not create the license file.');
  }

  async deleteAccount() {
    const ok = await this.dialog.confirm({
      title: 'Delete your account?',
      message: 'Your account, sign-in sessions, keys, installations and their diagnostics reports are deleted now. This cannot be undone.',
      confirmLabel: 'Delete account', danger: true, typeToConfirm: 'DELETE',
    });
    if (!ok) return;
    await this.run(async () => {
      await this.api.deleteAccount(this.deletePassword);
      this.deletePassword = '';
      this.toast.show('Account deleted', 'ok');
      await this.router.navigateByUrl('/');
    }, 'Could not delete the account.');
  }

  async signout() {
    try { await this.api.signout(); } catch { /* the session may already be gone */ }
    await this.router.navigateByUrl('/signin');
  }

  async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.show('Key copied', 'ok');
    } catch {
      this.toast.error('Could not copy. Select the key and copy it.');
    }
  }
}
