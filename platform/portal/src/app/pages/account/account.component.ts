import { Component, OnInit, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';
import { DialogService, ToastService } from '../../shared/feedback/feedback.service';
import { AccountInstall, AccountKey, LicenseAccountService } from './license-account.service';

export type AccountTab = 'keys' | 'installs' | 'offline' | 'delete';

@Component({
  selector: 'app-account',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterModule, SiteHeaderComponent, SiteFooterComponent],
  styleUrl: './site-page.css',
  template: `
    <app-site-header></app-site-header>
    <main class="sp" id="main">
      <section class="sp-section">
        <div class="sp-frame">
          <div class="sp-card-head">
            <h1 class="sp-display">Account</h1>
            @if (email) {
              <span class="sp-actions"><span class="sp-muted">{{ email }}</span><button type="button" class="btn btn-sm" (click)="signout()">Sign out</button></span>
            }
          </div>
          @if (loading) {
            <p class="sp-lede">Loading…</p>
          } @else {
            <nav class="sp-subnav" aria-label="Account sections">
              <button type="button" [class.active]="tab === 'keys'" [attr.aria-current]="tab === 'keys' ? 'page' : null" (click)="tab = 'keys'">Keys</button>
              <button type="button" [class.active]="tab === 'installs'" [attr.aria-current]="tab === 'installs' ? 'page' : null" (click)="tab = 'installs'">Installs</button>
              <button type="button" [class.active]="tab === 'offline'" [attr.aria-current]="tab === 'offline' ? 'page' : null" (click)="tab = 'offline'">Air-gapped servers</button>
              <button type="button" [class.active]="tab === 'delete'" [attr.aria-current]="tab === 'delete' ? 'page' : null" (click)="tab = 'delete'">Delete account</button>
            </nav>
            @if (error) { <p class="sp-msg sp-err" role="alert">{{ error }}</p> }

            @if (newKey) {
              <div class="sp-card" data-testid="new-key">
                <h2>Your new key</h2>
                <p class="sp-text">Copy it now: it is shown only once.</p>
                <div class="sp-secret">{{ newKey }}</div>
                <div class="sp-actions">
                  <button type="button" class="btn btn-primary" (click)="copy(newKey)">Copy key</button>
                  <button type="button" class="btn" (click)="newKey = ''">Done</button>
                </div>
              </div>
            }

            @if (tab === 'keys') {
              @if (!keys.length) {
                <div class="sp-card">
                  <p class="sp-text">You have no license key yet.</p>
                  <div class="sp-actions"><button type="button" class="btn btn-primary" (click)="createKey()" [disabled]="busy">Create a Personal key</button></div>
                </div>
              } @else {
                <ul class="sp-rows" data-testid="keys">
                  @for (k of keys; track k.id) {
                    <li>
                      <div class="sp-row-main">
                        <strong>{{ planName(k) }}@if (k.org) { · {{ k.org }} }</strong>
                        <span class="sp-mono">{{ k.hint || k.id }}</span>
                        <span class="sp-muted">{{ limits(k) }}@if (k.expires_at) { · expires {{ k.expires_at | date:'mediumDate' }} }</span>
                      </div>
                      <div class="sp-actions">
                        @if (k.revoked) {
                          <span class="status status-down">Revoked</span>
                        } @else {
                          <span class="status status-ok">Active</span>
                          <button type="button" class="btn btn-sm" (click)="rotate(k)" [disabled]="busy">Rotate</button>
                          <button type="button" class="btn btn-sm btn-danger" (click)="revoke(k)" [disabled]="busy">Revoke</button>
                        }
                      </div>
                    </li>
                  }
                </ul>
              }
              <p class="sp-muted">Need more servers or installs? <a routerLink="/pricing" fragment="enterprise">Get an Enterprise quote</a>.</p>
            }

            @if (tab === 'installs') {
              @if (!installs.length) {
                <p class="sp-text">No installs use your keys yet.</p>
              } @else {
                <ul class="sp-rows" data-testid="installs">
                  @for (i of installs; track i.id) {
                    <li>
                      <div class="sp-row-main">
                        <strong>{{ i.profile || 'Install' }}@if (i.version) { · {{ i.version }} }@if (i.activated_at) { · added {{ i.activated_at | date:'mediumDate' }} }</strong>
                        <span class="sp-mono">{{ i.id }}</span>
                        <span class="sp-muted">{{ i.node_count || 1 }} {{ (i.node_count || 1) === 1 ? 'server' : 'servers' }}@if (i.last_seen_at) { · last seen {{ i.last_seen_at | date:'medium' }} }@if (i.offline) { · air-gapped }</span>
                      </div>
                      <div class="sp-actions">
                        @if (i.active === false) {
                          <span class="status status-warn">Deactivated</span>
                        } @else {
                          <span class="status status-ok">Active</span>
                          <button type="button" class="btn btn-sm btn-danger" (click)="deactivate(i)" [disabled]="busy">Deactivate</button>
                        }
                      </div>
                    </li>
                  }
                </ul>
              }
            }

            @if (tab === 'offline') {
              <form class="sp-form sp-narrow" (ngSubmit)="offline()" #of="ngForm">
                <p class="sp-text">Run <span class="sp-mono">sudo platformctl license request-offline</span> on the server, paste its output here, then run <span class="sp-mono">sudo platformctl license install-offline --file FILE</span> with the downloaded file.</p>
                <div class="sp-field">
                  <label for="off-key">Key</label>
                  <select id="off-key" name="key" [(ngModel)]="offlineKey" required>
                    @for (k of activeKeys; track k.id) { <option [value]="k.id">{{ planName(k) }} · {{ k.hint || k.id }}</option> }
                  </select>
                </div>
                <div class="sp-field">
                  <label for="off-request">Request</label>
                  <textarea id="off-request" name="request" [(ngModel)]="offlineRequest" required spellcheck="false"></textarea>
                </div>
                <div class="sp-actions"><button type="submit" class="btn btn-primary" [disabled]="!of.valid || busy">Download license file</button></div>
              </form>
            }

            @if (tab === 'delete') {
              <form class="sp-card sp-danger sp-form sp-narrow" (ngSubmit)="deleteAccount()" #df="ngForm">
                <h2>Delete account</h2>
                <p class="sp-text">Deletes your account, keys and installs. This cannot be undone.</p>
                <div class="sp-field"><label for="del-password">Password</label><input id="del-password" name="password" type="password" [(ngModel)]="deletePassword" required autocomplete="current-password"></div>
                <div class="sp-actions"><button type="submit" class="btn btn-danger" [disabled]="!df.valid || busy">Delete account</button></div>
              </form>
            }
          }
        </div>
      </section>
    </main>
    <app-site-footer></app-site-footer>
  `,
})
export class AccountComponent implements OnInit {
  private api = inject(LicenseAccountService);
  private router = inject(Router);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  tab: AccountTab = 'keys';
  loading = true;
  busy = false;
  error = '';
  email = '';
  keys: AccountKey[] = [];
  installs: AccountInstall[] = [];
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

  get activeKeys() { return this.keys.filter(k => !k.revoked); }

  async ngOnInit() {
    try {
      const res = await this.api.account();
      this.email = res?.account?.email || '';
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
      title: 'Delete your account?', message: 'Your account, keys and installs are deleted. This cannot be undone.',
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
