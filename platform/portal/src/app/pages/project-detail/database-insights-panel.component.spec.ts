import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DatabaseInsightsPanelComponent } from './database-insights-panel.component';

describe('DatabaseInsightsPanelComponent', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [DatabaseInsightsPanelComponent], providers: [provideHttpClient(), provideHttpClientTesting()] }));
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  it('discards a response after switching environments', async () => {
    const fixture = TestBed.createComponent(DatabaseInsightsPanelComponent);
    const c = fixture.componentInstance; c.project = {id:'p'};
    const old = c.load();
    const http = TestBed.inject(HttpTestingController);
    const oldRequest = http.expectOne('/api/projects/p/databases/insights?environment=production');
    c.environment = 'staging'; c.reset();
    http.expectOne('/api/projects/p/databases/insights?environment=staging').flush({enabled:false,reason:'Full profile required'});
    await Promise.resolve();
    oldRequest.flush({enabled:true,postgres:{connections:99}}); await old;
    expect(c.data.enabled).toBeFalse(); expect(c.samples).toEqual([]);
    fixture.destroy();
  });
  it('bounds trend history to 60 samples', async () => {
    const fixture = TestBed.createComponent(DatabaseInsightsPanelComponent);
    const c = fixture.componentInstance; c.project = {id:'p'}; c.samples = Array(60).fill(1);
    const work = c.load();
    TestBed.inject(HttpTestingController).expectOne('/api/projects/p/databases/insights?environment=production').flush({enabled:true,postgres:{connections:2}});
    await work; expect(c.samples.length).toBe(60); expect(c.samples[59]).toBe(2);
    fixture.destroy();
  });
  it('defaults to production even when it is not the first environment', () => {
    const fixture = TestBed.createComponent(DatabaseInsightsPanelComponent);
    const c = fixture.componentInstance;
    c.project = { id: 'p', environments: [{ name: 'staging' }, { name: 'production' }] };
    c.ngOnChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/projects/p/databases/insights?environment=production').flush({ enabled: false, reason: 'x' });
    expect(c.environment).toBe('production');
    expect(c.bytes(8091327)).toBe('7.7 MB');
    fixture.destroy();
  });
});
