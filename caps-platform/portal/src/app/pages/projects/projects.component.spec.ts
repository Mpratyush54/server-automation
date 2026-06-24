import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { ProjectsComponent } from './projects.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('ProjectsComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getProjects', 'createProject', 'deleteProject']);

    await TestBed.configureTestingModule({
      imports: [ProjectsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
    apiService.getProjects.and.returnValue(of([]));
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(ProjectsComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should load projects on init', async () => {
    apiService.getProjects.and.returnValue(of([
      { id: 'p1', name: 'Project A' },
      { id: 'p2', name: 'Project B' },
    ]));

    const fixture = TestBed.createComponent(ProjectsComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.projects.length).toBe(2);
  });

  it('should create a project', async () => {
    const newProject = { id: 'p3', name: 'New Project', stack: 'nodejs' };
    apiService.createProject.and.returnValue(of(newProject));

    const fixture = TestBed.createComponent(ProjectsComponent);
    fixture.detectChanges();
    fixture.componentInstance.newProject = { name: 'New Project', stack: 'nodejs', repositoryUrl: '' };

    await fixture.componentInstance.create();

    expect(fixture.componentInstance.projects.length).toBe(1);
    expect(fixture.componentInstance.showCreate).toBeFalse();
  });

  it('should delete a project', async () => {
    spyOn(window, 'confirm').and.returnValue(true);
    apiService.deleteProject.and.returnValue(of({}));

    const fixture = TestBed.createComponent(ProjectsComponent);
    fixture.componentInstance.projects = [{ id: 'p1', name: 'Test' }];

    await fixture.componentInstance.delete('p1');

    expect(fixture.componentInstance.projects.length).toBe(0);
  });

  it('should not delete when confirmation is cancelled', async () => {
    spyOn(window, 'confirm').and.returnValue(false);

    const fixture = TestBed.createComponent(ProjectsComponent);
    fixture.componentInstance.projects = [{ id: 'p1', name: 'Test' }];

    await fixture.componentInstance.delete('p1');

    expect(fixture.componentInstance.projects.length).toBe(1);
  });

  it('should toggle create form', () => {
    const fixture = TestBed.createComponent(ProjectsComponent);
    expect(fixture.componentInstance.showCreate).toBeFalse();
    fixture.componentInstance.showCreate = true;
    expect(fixture.componentInstance.showCreate).toBeTrue();
  });
});
