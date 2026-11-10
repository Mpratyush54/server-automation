import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { EnvironmentTabComponent, parseDotEnv } from './environment-tab.component';
import { ApiService } from '../../../services/api.service';
import { StepUpService } from '../../../services/step-up.service';

const PROJ = 'p1';
const ENV = { id: 'env-stg', name: 'staging' };
const allCaps = {
  canReadValues: true, canReveal: true, canWritePlain: true, canWriteSecret: true, canDeletePlain: true,
  canDeleteSecret: true, canImport: true, canExport: true, canViewHistory: true, canRollback: true,
};
const noCaps = Object.fromEntries(Object.keys(allCaps).map((k) => [k, false]));

function rows(viewer = false) {
  return [
    { key: 'API_URL', type: 'plain', value: viewer ? null : 'https://api.example.test', masked: viewer, environmentId: null, scope: 'global', version: null, updatedBy: 'Lead', updatedAt: '2026-01-01T00:00:00.000Z', secretId: null, conflict: false },
    { key: 'DB_PASSWORD', type: 'secret', value: null, masked: true, environmentId: ENV.id, scope: 'environment', version: 2, updatedBy: null, updatedAt: null, secretId: 's1', conflict: false },
    { key: 'DUP', type: 'plain', value: viewer ? null : 'p', masked: viewer, environmentId: ENV.id, scope: 'environment', version: null, updatedBy: null, updatedAt: null, secretId: null, conflict: true },
    { key: 'DUP', type: 'secret', value: null, masked: true, environmentId: ENV.id, scope: 'environment', version: 1, updatedBy: null, updatedAt: null, secretId: 's2', conflict: true },
  ];
}

describe('EnvironmentTabComponent (#29)', () => {
  let api: jasmine.SpyObj<ApiService>;
  let stepUp: jasmine.SpyObj<StepUpService>;

  async function render(viewer = false) {
    api.getEnvironmentVars.and.returnValue(of({ variables: rows(viewer), capabilities: viewer ? noCaps : allCaps, conflicts: 2 }));
    const fixture = TestBed.createComponent(EnvironmentTabComponent);
    fixture.componentRef.setInput('projectId', PROJ);
    fixture.componentRef.setInput('environments', [ENV]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(async () => {
    api = jasmine.createSpyObj('ApiService', [
      'getEnvironmentVars', 'setEnvironmentVar', 'deleteEnvironmentVar', 'revealSecret', 'bulkImportSecrets',
      'getSecretVersions', 'rollbackSecret', 'exportSecrets',
    ]);
    stepUp = jasmine.createSpyObj('StepUpService', ['run']);
    stepUp.run.and.callFake((action: () => Promise<any>) => action());
    await TestBed.configureTestingModule({
      imports: [EnvironmentTabComponent],
      providers: [{ provide: ApiService, useValue: api }, { provide: StepUpService, useValue: stepUp }],
    }).compileComponents();
  });

  it('renders one merged table with type badges, masked secrets and conflict badges', async () => {
    const fixture = await render();
    const el: HTMLElement = fixture.nativeElement;
    expect(api.getEnvironmentVars).toHaveBeenCalledWith(PROJ, undefined);
    const text = el.textContent || '';
    expect(text).toContain('https://api.example.test');
    expect(text).toContain('••••••••');
    expect(el.querySelectorAll('.env-badge-secret').length).toBe(2);
    expect(el.querySelectorAll('.env-conflict-row').length).toBe(2);
    expect(text).toContain('Keep secret');
    expect(text).toContain('Keep plain');
  });

  it('reveal goes through the existing reveal endpoint with step-up', async () => {
    const fixture = await render();
    api.revealSecret.and.returnValue(of({ value: 'hunter2' }));
    const row = fixture.componentInstance.rows.find((r) => r.key === 'DB_PASSWORD')!;
    await fixture.componentInstance.reveal(row);
    fixture.detectChanges();
    expect(stepUp.run).toHaveBeenCalled();
    expect(api.revealSecret).toHaveBeenCalledWith(PROJ, { environmentId: ENV.id, key: 'DB_PASSWORD' });
    expect(fixture.nativeElement.textContent).toContain('hunter2');
  });

  it('viewers see keys and types only: no values, no write/reveal actions', async () => {
    const fixture = await render(true);
    const el: HTMLElement = fixture.nativeElement;
    const text = el.textContent || '';
    expect(text).toContain('API_URL');
    expect(text).not.toContain('https://api.example.test');
    expect(text).toContain('keys and types only');
    const buttons = Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim());
    for (const label of ['Reveal', 'Edit', 'Delete', '+ Add variable', 'Paste .env', 'Keep secret', 'Keep plain', 'History']) {
      expect(buttons).not.toContain(label);
    }
  });

  it('"Encrypt as secret" toggle sends secret=true and converting needs no new value', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    api.setEnvironmentVar.and.returnValue(of({ type: 'secret', convertedFrom: 'plain' }));
    c.openForm(c.rows[0]); // plain API_URL
    c.form.secret = true;
    c.form.value = '';
    expect(c.canSave()).toBeTrue();
    await c.save();
    expect(api.setEnvironmentVar).toHaveBeenCalledWith(PROJ, 'API_URL', { environmentId: null, secret: true });
  });

  it('new variables need a valid key and a value', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    c.openForm();
    c.form.key = '1 bad';
    c.form.value = 'x';
    expect(c.canSave()).toBeFalse();
    c.form.key = 'GOOD_KEY';
    c.form.value = '';
    expect(c.canSave()).toBeFalse();
    c.form.value = 'v';
    expect(c.canSave()).toBeTrue();
  });

  it('bulk import: new secrets via /secrets/bulk, plain lines and plain→secret moves via PUT', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    api.bulkImportSecrets.and.returnValue(of({ imported: 1 }));
    api.setEnvironmentVar.and.returnValue(of({}));
    c.openBulk();
    c.bulkEnvId = ENV.id;
    c.bulkText = 'NEW_TOKEN=abc\nDUP=moved\nLOG_LEVEL=info';
    c.parseBulk();
    c.bulkLines.find((l) => l.key === 'DUP')!.secret = true;
    await c.importBulk();
    expect(api.bulkImportSecrets).toHaveBeenCalledWith(PROJ, { environmentId: ENV.id, secrets: [{ key: 'NEW_TOKEN', value: 'abc' }] });
    expect(api.setEnvironmentVar).toHaveBeenCalledWith(PROJ, 'DUP', { environmentId: ENV.id, value: 'moved', secret: true });
    expect(api.setEnvironmentVar).toHaveBeenCalledWith(PROJ, 'LOG_LEVEL', { environmentId: ENV.id, value: 'info', secret: false });
  });

  it('shows a load error instead of throwing', async () => {
    api.getEnvironmentVars.and.returnValue(throwError(() => ({ error: { error: 'nope' } })));
    const fixture = TestBed.createComponent(EnvironmentTabComponent);
    fixture.componentRef.setInput('projectId', PROJ);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('nope');
  });
});

describe('parseDotEnv', () => {
  it('parses KEY=VALUE lines, quotes, export and comments; guesses secret keys', () => {
    const lines = parseDotEnv('# comment\nexport API_URL="https://x.test/?a=b"\n\nDB_PASSWORD=\'p=w\'\nbad line\n1BAD=x');
    expect(lines).toEqual([
      { key: 'API_URL', value: 'https://x.test/?a=b', secret: false, valid: true },
      { key: 'DB_PASSWORD', value: 'p=w', secret: true, valid: true },
      { key: '1BAD', value: 'x', secret: false, valid: false },
    ]);
  });
});
