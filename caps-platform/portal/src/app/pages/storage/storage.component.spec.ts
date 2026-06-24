import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { StorageComponent } from './storage.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('StorageComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getStorageAnalytics', 'getProjectFiles']);

    await TestBed.configureTestingModule({
      imports: [StorageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(StorageComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should load analytics and files', async () => {
    apiService.getStorageAnalytics.and.returnValue(of({ totalSize: 1024, fileCount: 5 }));
    apiService.getProjectFiles.and.returnValue(of([{ id: 'f1', name: 'test.txt' }]));

    const fixture = TestBed.createComponent(StorageComponent);
    fixture.componentInstance.projectId = 'p1';

    await fixture.componentInstance.loadAnalytics();

    expect(fixture.componentInstance.analytics).toEqual({ totalSize: 1024, fileCount: 5 });
    expect(fixture.componentInstance.files.length).toBe(1);
  });

  it('should handle errors gracefully', async () => {
    apiService.getStorageAnalytics.and.returnValue(of(null));
    apiService.getProjectFiles.and.returnValue(of(null));

    const fixture = TestBed.createComponent(StorageComponent);
    fixture.componentInstance.projectId = 'p1';

    await fixture.componentInstance.loadAnalytics();

    expect(fixture.componentInstance.analytics).toBeNull();
  });
});
