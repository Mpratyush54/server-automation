import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { ConfigComponent } from './config.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('ConfigComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getConfig', 'setConfig']);

    await TestBed.configureTestingModule({
      imports: [ConfigComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(ConfigComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should not load config when projectId is empty', async () => {
    const fixture = TestBed.createComponent(ConfigComponent);
    fixture.componentInstance.projectId = '';

    await fixture.componentInstance.load();

    expect(apiService.getConfig).not.toHaveBeenCalled();
  });

  it('should load config entries', async () => {
    apiService.getConfig.and.returnValue(of({
      DB_HOST: 'localhost',
      SECRET_KEY: '***',
      FEATURE_X: 'true',
    }));

    const fixture = TestBed.createComponent(ConfigComponent);
    fixture.componentInstance.projectId = 'p1';

    await fixture.componentInstance.load();

    expect(fixture.componentInstance.configEntries.length).toBe(3);
    expect(fixture.componentInstance.configEntries.find(c => c.key === 'SECRET_KEY')?.isSecret).toBeTrue();
  });

  it('should set config', async () => {
    apiService.setConfig.and.returnValue(of({}));
    apiService.getConfig.and.returnValue(of({ NEW_KEY: 'new-value' }));

    const fixture = TestBed.createComponent(ConfigComponent);
    fixture.componentInstance.projectId = 'p1';
    fixture.componentInstance.newConfig = { key: 'NEW_KEY', value: 'new-value', isSecret: false };

    await fixture.componentInstance.setConfig();

    expect(apiService.setConfig).toHaveBeenCalled();
    expect(fixture.componentInstance.newConfig.key).toBe('');
  });

  it('should not set config when projectId or key is empty', async () => {
    const fixture = TestBed.createComponent(ConfigComponent);
    fixture.componentInstance.projectId = '';
    fixture.componentInstance.newConfig = { key: '', value: 'v', isSecret: false };

    await fixture.componentInstance.setConfig();

    expect(apiService.setConfig).not.toHaveBeenCalled();
  });
});
