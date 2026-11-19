import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, ActivatedRoute, convertToParamMap } from '@angular/router';
import { LicenseAccountService, LicenseApiError, LICENSE_SERVER, exportFilename } from './license-account.service';
import { PricingComponent, readQuote } from './pricing.component';
import { SignupComponent } from './signup.component';
import { SigninComponent } from './signin.component';
import { VerifyEmailComponent } from './verify-email.component';
import { AccountComponent, formatDuration, reportKindLabel } from './account.component';
import { DialogService, ToastService } from '../../shared/feedback/feedback.service';

function response(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('LicenseAccountService', () => {
  it('sends JSON with credentials to the license server', async () => {
    const svc = new LicenseAccountService();
    const calls: [string, RequestInit][] = [];
    svc.fetchFn = (async (url: string, init: RequestInit) => { calls.push([url, init]); return response(202, null); }) as any;
    await svc.signup('a@example.com', 'correct horse battery');
    const [url, init] = calls[0];
    expect(url).toBe(LICENSE_SERVER + '/v1/auth/signup');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as any)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@example.com', password: 'correct horse battery' });
  });

  it('raises the server error code and message', async () => {
    const svc = new LicenseAccountService();
    svc.fetchFn = (async () => response(403, { error: { code: 'email_not_verified', message: 'Verify first' } })) as any;
    await expectAsync(svc.signin('a@example.com', 'x')).toBeRejectedWith(jasmine.objectContaining({ status: 403, code: 'email_not_verified', message: 'Verify first' }));
  });

  it('reports network failures', async () => {
    const svc = new LicenseAccountService();
    svc.fetchFn = (async () => { throw new TypeError('offline'); }) as any;
    await expectAsync(svc.account()).toBeRejectedWith(jasmine.objectContaining({ code: 'network' }));
  });

  it('sends the public quote form without cookies', async () => {
    const svc = new LicenseAccountService();
    const calls: [string, RequestInit][] = [];
    svc.fetchFn = (async (url: string, init: RequestInit) => { calls.push([url, init]); return response(202, null); }) as any;
    await svc.requestQuote({ company: 'Acme', name: 'Ada', email: 'ada@acme.test', servers: 3, message: '', website: '' });
    expect(calls[0][0]).toBe(LICENSE_SERVER + '/v1/quotes/request');
    expect(calls[0][1].credentials).toBe('omit');
  });

  it('encodes ids in paths', async () => {
    const svc = new LicenseAccountService();
    let seen = '';
    svc.fetchFn = (async (url: string) => { seen = url; return response(200, {}); }) as any;
    await svc.rotateKey('a/b');
    expect(seen).toBe(LICENSE_SERVER + '/v1/account/keys/a%2Fb/rotate');
  });

  it('reads the diagnostics reports of an install', async () => {
    const svc = new LicenseAccountService();
    const calls: [string, RequestInit][] = [];
    svc.fetchFn = (async (url: string, init: RequestInit) => { calls.push([url, init]); return response(200, { install_id: 'ins/1', reports: [], truncated: false }); }) as any;
    const res = await svc.installReports('ins/1');
    expect(calls[0][0]).toBe(LICENSE_SERVER + '/v1/account/installs/ins%2F1/reports');
    expect(calls[0][1].method).toBe('GET');
    expect(calls[0][1].credentials).toBe('include');
    expect(res.reports).toEqual([]);
    await svc.installReports('ins_2', 10);
    expect(calls[1][0]).toBe(LICENSE_SERVER + '/v1/account/installs/ins_2/reports?limit=10');
  });

  it('downloads the account export as raw JSON with its file name', async () => {
    const svc = new LicenseAccountService();
    const body = '{\n  "format": "x"\n}\n';
    let seen = '';
    svc.fetchFn = (async (url: string) => {
      seen = url;
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="cairn-account-data-2026-11-19.json"' } });
    }) as any;
    const res = await svc.exportData();
    expect(seen).toBe(LICENSE_SERVER + '/v1/account/export');
    expect(res).toEqual({ filename: 'cairn-account-data-2026-11-19.json', content: body });
    svc.fetchFn = (async () => response(401, { error: { code: 'unauthorized', message: 'sign in required' } })) as any;
    await expectAsync(svc.exportData()).toBeRejectedWith(jasmine.objectContaining({ status: 401 }));
  });

  it('only accepts safe export file names', () => {
    expect(exportFilename(null)).toBe('cairn-account-data.json');
    expect(exportFilename('attachment; filename="../../evil.sh"')).toBe('cairn-account-data.json');
    expect(exportFilename('attachment; filename=data.json')).toBe('data.json');
  });
});

describe('public account pages', () => {
  let api: jasmine.SpyObj<LicenseAccountService>;
  let dialog: jasmine.SpyObj<DialogService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj<LicenseAccountService>('LicenseAccountService', [
      'signup', 'resend', 'signin', 'signout', 'verify', 'account', 'keys', 'installs', 'createKey', 'rotateKey', 'revokeKey',
      'deactivateInstall', 'offline', 'deleteAccount', 'requestQuote', 'installReports', 'exportData',
    ]);
    dialog = jasmine.createSpyObj<DialogService>('DialogService', ['confirm', 'prompt']);
    dialog.confirm.and.resolveTo(true);
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: LicenseAccountService, useValue: api },
        { provide: DialogService, useValue: dialog },
      ],
    }).compileComponents();
  });

  function renderPricing() {
    const f = TestBed.createComponent(PricingComponent);
    f.detectChanges();
    return f;
  }

  function fillQuote(el: HTMLElement, values: Record<string, string>) {
    for (const [name, value] of Object.entries(values)) {
      (el.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
    }
  }

  const valid = { company: 'Acme', name: 'Ada', email: 'ada@acme.test', servers: '12', message: 'Hi' };

  it('pricing shows the plans, the enterprise anchor and the starting price', () => {
    const el = renderPricing().nativeElement as HTMLElement;
    expect(el.querySelector('#enterprise')).not.toBeNull();
    expect(el.querySelector('a[href="/signup"]')).not.toBeNull();
    expect(el.textContent).toContain('From $9');
    expect(el.textContent).toContain('per server per month, billed annually');
    expect(el.querySelector('input[name="website"]')?.getAttribute('tabindex')).toBe('-1');
  });

  it('reads and checks the quote form', () => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ ...valid, website: '' })) form.set(k, v);
    const ok = readQuote(form);
    expect(ok.quote).toEqual({ company: 'Acme', name: 'Ada', email: 'ada@acme.test', servers: 12, message: 'Hi', website: '' });
    expect(Object.values(ok.errors).every(v => !v)).toBeTrue();
    form.set('email', 'nope');
    form.set('servers', '0');
    form.set('company', ' ');
    const bad = readQuote(form);
    expect(bad.errors.email).toBeTruthy();
    expect(bad.errors.servers).toBeTruthy();
    expect(bad.errors.company).toBeTruthy();
  });

  function submit(f: ReturnType<typeof renderPricing>) {
    const form = (f.nativeElement as HTMLElement).querySelector('form')!;
    return f.componentInstance.send({ preventDefault() {}, target: form } as unknown as Event);
  }

  it('posts the quote and shows the thank-you state', async () => {
    api.requestQuote.and.resolveTo(null);
    const f = renderPricing();
    fillQuote(f.nativeElement, valid);
    await submit(f);
    f.detectChanges();
    expect(api.requestQuote).toHaveBeenCalledWith({ company: 'Acme', name: 'Ada', email: 'ada@acme.test', servers: 12, message: 'Hi', website: '' });
    expect((f.nativeElement as HTMLElement).querySelector('[data-testid="quote-sent"]')?.textContent).toContain('one business day');
  });

  it('shows inline errors without posting an invalid form', async () => {
    const f = renderPricing();
    fillQuote(f.nativeElement, { ...valid, email: 'x' });
    await submit(f);
    f.detectChanges();
    expect(api.requestQuote).not.toHaveBeenCalled();
    expect((f.nativeElement as HTMLElement).querySelector('#q-email')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('maps server validation, rate limits and network failures', async () => {
    const toast = TestBed.inject(ToastService);
    spyOn(toast, 'error');
    const f = renderPricing();
    fillQuote(f.nativeElement, valid);
    api.requestQuote.and.rejectWith(new LicenseApiError(400, 'invalid', 'bad', { email: 'Use a work email.' }));
    await submit(f);
    expect(f.componentInstance.errors.email).toBe('Use a work email.');
    api.requestQuote.and.rejectWith(new LicenseApiError(429, 'rate_limited', 'slow down'));
    await submit(f);
    expect(f.componentInstance.formError).toContain('Too many requests');
    api.requestQuote.and.rejectWith(new LicenseApiError(0, 'network', 'offline'));
    await submit(f);
    expect(toast.error).toHaveBeenCalled();
    expect(f.componentInstance.sent).toBeFalse();
  });

  it('sign-up shows the check-your-inbox step and clears the password', async () => {
    api.signup.and.resolveTo(null);
    const c = TestBed.createComponent(SignupComponent).componentInstance;
    c.email = ' a@example.com ';
    c.password = 'a long password';
    await c.submit();
    expect(api.signup).toHaveBeenCalledWith('a@example.com', 'a long password');
    expect(c.sent).toBeTrue();
    expect(c.password).toBe('');
  });

  it('sign-in goes to the account page, or asks to confirm the email', async () => {
    const router = TestBed.inject(Router);
    spyOn(router, 'navigateByUrl').and.resolveTo(true);
    const c = TestBed.createComponent(SigninComponent).componentInstance;
    c.email = 'a@example.com';
    c.password = 'pw';
    api.signin.and.resolveTo({});
    await c.submit();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/account');
    api.signin.and.rejectWith(new LicenseApiError(403, 'email_not_verified', 'x'));
    await c.submit();
    expect(c.unverified).toBeTrue();
    api.resend.and.resolveTo(null);
    await c.resend();
    expect(api.resend).toHaveBeenCalledWith('a@example.com');
    expect(c.resent).toBeTrue();
  });

  it('sign-in links to sign-up, Terms and Privacy and maps bad credentials', async () => {
    const f = TestBed.createComponent(SigninComponent);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('a[href="/signup"]')).not.toBeNull();
    expect(el.querySelector('a[href="/terms"]')).not.toBeNull();
    expect(el.querySelector('a[href="/privacy"]')).not.toBeNull();
    expect(el.querySelector('#si-email')?.getAttribute('autocomplete')).toBe('email');
    expect(el.querySelector('#si-password')?.getAttribute('autocomplete')).toBe('current-password');
    api.signin.and.rejectWith(new LicenseApiError(401, 'invalid_credentials', 'x'));
    f.componentInstance.email = 'a@example.com';
    f.componentInstance.password = 'wrong';
    await f.componentInstance.submit();
    f.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Email or password is wrong.');
  });

  it('verify-email shows the key once and removes the token from the URL', async () => {
    TestBed.overrideProvider(ActivatedRoute, { useValue: { snapshot: { queryParamMap: convertToParamMap({ token: 'tok' }) } } });
    const router = TestBed.inject(Router);
    const nav = spyOn(router, 'navigate').and.resolveTo(true);
    api.verify.and.resolveTo({ verified: true, license_key: 'cairn_0123_secret' });
    const f = TestBed.createComponent(VerifyEmailComponent);
    await f.componentInstance.ngOnInit();
    f.detectChanges();
    expect(api.verify).toHaveBeenCalledWith('tok');
    expect(nav.calls.mostRecent().args[1]).toEqual(jasmine.objectContaining({ queryParams: {}, replaceUrl: true }));
    expect((f.nativeElement as HTMLElement).querySelector('[data-testid="license-key"]')?.textContent).toContain('cairn_0123_secret');
  });

  it('verify-email explains an expired link', async () => {
    TestBed.overrideProvider(ActivatedRoute, { useValue: { snapshot: { queryParamMap: convertToParamMap({ token: 'old' }) } } });
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    api.verify.and.rejectWith(new LicenseApiError(400, 'invalid_token', 'bad'));
    const c = TestBed.createComponent(VerifyEmailComponent).componentInstance;
    await c.ngOnInit();
    expect(c.state).toBe('failed');
    expect(c.error).toContain('expired');
  });

  function loadAccount() {
    api.account.and.resolveTo({ account: { email: 'a@example.com', email_verified: true, email_verified_at: '2026-11-02T10:00:00Z', created_at: '2026-11-01T09:00:00Z' } });
    api.keys.and.resolveTo({ keys: [{ id: 'k1', hint: 'cairn_ab12…', plan: 'personal', max_nodes: 3, max_installs: 2 }] });
    api.installs.and.resolveTo({ installs: [{
      id: 'ins_1', key_id: 'k1', profile: 'standard', version: '2.0.0', node_count: 1, active: true, fingerprint_prefix: '9f2c0123abcd',
      activated_at: '2026-11-03T08:00:00Z', last_seen_at: '2026-11-18T08:00:00Z',
    }] });
    api.installReports.and.resolveTo({ install_id: 'ins_1', reports: [] });
  }

  const failedReport = {
    id: 'rep_1', install_id: 'ins_1', received_at: '2026-11-18T08:00:00Z', kind: 'upgrade', version: '2.0.0', profile: 'standard', failed: true,
    payload: {
      schema: 1, kind: 'upgrade', generated_at: '2026-11-18T07:59:00Z',
      platform: { version: '2.0.0', profile: 'standard', node_count: 3, arch: 'amd64', os_release: 'Ubuntu 24.04', k8s_version: 'v1.31.4+k3s1' },
      uptime_seconds: 3600,
      steps: [{ step: 'preflight', seconds: 2, status: 'ok' }, { step: 'helm.platform-api', seconds: 30.5, status: 'failed' }],
      failures: [{ step: 'helm.platform-api', error: 'timed out waiting for rollout' }],
      components: [{ name: 'platform-api', status: 'degraded' }],
      counts: { projects: 1, environments: 2, deployments: 3, users: 1 },
    },
  };

  async function renderAccount() {
    const f = TestBed.createComponent(AccountComponent);
    f.detectChanges(); // runs ngOnInit
    // The API spies settle at once; the air-gap story keeps timers running, so whenStable() would never resolve.
    for (let n = 0; n < 3; n++) await new Promise(r => setTimeout(r));
    await f.componentInstance.reportsLoaded;
    f.detectChanges();
    return f;
  }

  it('labels report kinds and durations for people', () => {
    expect(reportKindLabel('periodic')).toBe('Weekly check-in');
    expect(reportKindLabel('provision')).toBe('Installation');
    expect(reportKindLabel('newkind')).toBe('Newkind');
    expect(formatDuration(30.5)).toBe('30.5 s');
    expect(formatDuration(3600)).toBe('1 h 0 min');
    expect(formatDuration(undefined)).toBe('');
  });

  it('account shows the overview: email, member since and email confirmation', async () => {
    loadAccount();
    const el = (await renderAccount()).nativeElement as HTMLElement;
    const overview = el.querySelector('[data-testid="overview"]')!.textContent!;
    expect(overview).toContain('a@example.com');
    expect(overview).toContain('Member since');
    expect(overview).toContain('Nov 1, 2026');
    expect(overview).toContain('Nov 2, 2026');
    for (const id of ['keys', 'installs', 'offline', 'data', 'delete']) expect(el.querySelector('#' + id)).withContext(id).not.toBeNull();
  });

  it('account "Your data" lists stored install fields and diagnostics reports with the raw JSON', async () => {
    loadAccount();
    api.installReports.and.resolveTo({ install_id: 'ins_1', reports: [failedReport], truncated: false });
    const el = (await renderAccount()).nativeElement as HTMLElement;
    expect(api.installReports).toHaveBeenCalledWith('ins_1');
    const install = el.querySelector('[data-testid="data-install"]')!;
    expect(install.textContent).toContain('ins_1');
    expect(install.textContent).toContain('salted hash');
    expect(install.textContent).toContain('9f2c0123abcd');
    expect(install.textContent).toContain('Personal · cairn_ab12…');
    const report = install.querySelector('details.ac-report') as HTMLDetailsElement;
    expect(report.querySelector('summary')!.textContent).toContain('Upgrade');
    expect(report.querySelector('summary')!.textContent).toContain('Failed');
    expect(report.textContent).toContain('Ubuntu 24.04');
    expect(report.textContent).toContain('helm.platform-api');
    expect(report.textContent).toContain('timed out waiting for rollout');
    expect(report.textContent).toContain('platform-api: degraded');
    expect(report.textContent).toContain('3 deployments');
    const raw = JSON.parse(report.querySelector('[data-testid="raw-json"]')!.textContent!);
    expect(raw).toEqual(failedReport.payload);
    const links = Array.from(el.querySelectorAll('#data a')).map(a => a.getAttribute('href'));
    expect(links).toContain('/privacy#accounts');
    expect(links).toContain('/privacy#installations');
    expect(links).toContain('/privacy#diagnostics');
    expect(el.querySelector('#data')!.textContent).toContain('PLATFORM_DIAGNOSTICS=off');
    expect(el.querySelector('#data')!.textContent).toContain('privacy@cairnpaas.dev');
  });

  it('account "Your data" handles empty and failed report loads per install', async () => {
    loadAccount();
    let f = await renderAccount();
    expect((f.nativeElement as HTMLElement).querySelector('[data-testid="no-reports"]')).not.toBeNull();

    api.installReports.and.rejectWith(new LicenseApiError(500, 'internal', 'internal error'));
    f = await renderAccount();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="data-install"] [role="alert"]')?.textContent).toContain('internal error');
    api.installReports.and.resolveTo({ install_id: 'ins_1', reports: [failedReport] });
    await f.componentInstance.loadInstallReports('ins_1');
    f.detectChanges();
    expect(el.querySelector('[data-testid="reports"]')).not.toBeNull();
  });

  it('account "Your data" says when no installations are stored', async () => {
    loadAccount();
    api.installs.and.resolveTo({ installs: [] });
    const el = (await renderAccount()).nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="data-no-installs"]')).not.toBeNull();
    expect(api.installReports).not.toHaveBeenCalled();
  });

  it('account downloads all data as JSON', async () => {
    loadAccount();
    const c = (await renderAccount()).componentInstance;
    let saved: [string, string] | null = null;
    c.download = (name, content) => { saved = [name, content]; };
    api.exportData.and.resolveTo({ filename: 'cairn-account-data-2026-11-19.json', content: '{"format":"x"}' });
    await c.exportData();
    expect(saved!).toEqual(['cairn-account-data-2026-11-19.json', '{"format":"x"}']);

    const toast = TestBed.inject(ToastService);
    spyOn(toast, 'error');
    api.exportData.and.rejectWith(new LicenseApiError(429, 'rate_limited', 'slow'));
    await c.exportData();
    expect(toast.error).toHaveBeenCalledWith(jasmine.stringMatching('Too many downloads'));
    expect(c.exporting).toBeFalse();
  });

  it('account shows a load error when the account service fails', async () => {
    api.account.and.rejectWith(new LicenseApiError(0, 'network', 'Could not reach the account service.'));
    const el = (await renderAccount()).nativeElement as HTMLElement;
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Could not reach');
    expect(el.querySelector('#data')).toBeNull();
  });

  it('account shows the air-gapped install story beside the offline license form', async () => {
    loadAccount();
    const el = (await renderAccount()).nativeElement as HTMLElement;
    const offline = el.querySelector('#offline')!;
    expect(offline.textContent).toContain('Servers without internet access');
    expect(offline.querySelector('.ac-split-main form')).not.toBeNull();
    expect(offline.querySelector('.ac-split-aside app-airgap-story figure.ag')).not.toBeNull();
    expect(offline.querySelector('a[href="/docs/getting-started/platformctl#offline-bundle"]')).not.toBeNull();
  });

  it('account explains what deletion removes', async () => {
    loadAccount();
    const el = (await renderAccount()).nativeElement as HTMLElement;
    const scope = el.querySelector('[data-testid="delete-scope"]')!.textContent!;
    for (const item of ['email address', 'password hash', 'sessions', 'license keys', 'diagnostics reports']) expect(scope).toContain(item);
  });

  it('account redirects to sign-in without a session', async () => {
    const router = TestBed.inject(Router);
    spyOn(router, 'navigateByUrl').and.resolveTo(true);
    api.account.and.rejectWith(new LicenseApiError(401, 'unauthorized', 'x'));
    await TestBed.createComponent(AccountComponent).componentInstance.ngOnInit();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/signin');
  });

  it('account lists keys and installs, rotates and deactivates after confirming', async () => {
    loadAccount();
    const f = TestBed.createComponent(AccountComponent);
    const c = f.componentInstance;
    await c.ngOnInit();
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="keys"]')?.textContent).toContain('Personal');
    expect(c.offlineKey).toBe('k1');

    api.rotateKey.and.resolveTo({ license_key: 'cairn_new', key: { id: 'k1' } });
    await c.rotate(c.keys[0]);
    expect(api.rotateKey).toHaveBeenCalledWith('k1');
    expect(c.newKey).toBe('cairn_new');

    dialog.confirm.and.resolveTo(false);
    await c.deactivate(c.installs[0]);
    expect(api.deactivateInstall).not.toHaveBeenCalled();
    dialog.confirm.and.resolveTo(true);
    api.deactivateInstall.and.resolveTo({});
    await c.deactivate(c.installs[0]);
    expect(api.deactivateInstall).toHaveBeenCalledWith('ins_1');
  });

  it('account downloads an offline license file', async () => {
    loadAccount();
    const c = TestBed.createComponent(AccountComponent).componentInstance;
    await c.ngOnInit();
    let saved: [string, string] | null = null;
    c.download = (name, content) => { saved = [name, content]; };
    api.offline.and.resolveTo({ install_id: 'ins_2', expires_at: '', filename: 'cairn-license-ins_2.json', license_file: '{"x":1}' });
    c.offlineRequest = ' CAIRN-OFFLINE-REQUEST-V1.abc ';
    await c.offline();
    expect(api.offline).toHaveBeenCalledWith('k1', 'CAIRN-OFFLINE-REQUEST-V1.abc');
    expect(saved!).toEqual(['cairn-license-ins_2.json', '{"x":1}']);
  });

  it('account deletion asks for typed confirmation', async () => {
    loadAccount();
    const router = TestBed.inject(Router);
    spyOn(router, 'navigateByUrl').and.resolveTo(true);
    const c = TestBed.createComponent(AccountComponent).componentInstance;
    await c.ngOnInit();
    c.deletePassword = 'pw';
    api.deleteAccount.and.resolveTo({});
    await c.deleteAccount();
    expect(dialog.confirm.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ danger: true, typeToConfirm: 'DELETE' }));
    expect(api.deleteAccount).toHaveBeenCalledWith('pw');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/');
  });
});
