import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, ActivatedRoute, convertToParamMap } from '@angular/router';
import { LicenseAccountService, LicenseApiError, LICENSE_SERVER } from './license-account.service';
import { PricingComponent, readQuote } from './pricing.component';
import { SignupComponent } from './signup.component';
import { SigninComponent } from './signin.component';
import { VerifyEmailComponent } from './verify-email.component';
import { AccountComponent } from './account.component';
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
});

describe('public account pages', () => {
  let api: jasmine.SpyObj<LicenseAccountService>;
  let dialog: jasmine.SpyObj<DialogService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj<LicenseAccountService>('LicenseAccountService', [
      'signup', 'resend', 'signin', 'signout', 'verify', 'account', 'keys', 'installs', 'createKey', 'rotateKey', 'revokeKey',
      'deactivateInstall', 'offline', 'deleteAccount', 'requestQuote',
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
    api.account.and.resolveTo({ account: { email: 'a@example.com' } });
    api.keys.and.resolveTo({ keys: [{ id: 'k1', hint: 'cairn_ab12…', plan: 'personal', max_nodes: 3, max_installs: 2 }] });
    api.installs.and.resolveTo({ installs: [{ id: 'ins_1', profile: 'standard', node_count: 1, active: true }] });
  }

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
