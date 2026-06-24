import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { DbConnectionsComponent } from './db-connections.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('DbConnectionsComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getDbConnections', 'createDbConnection', 'deleteDbConnection']);

    await TestBed.configureTestingModule({
      imports: [DbConnectionsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
    apiService.getDbConnections.and.returnValue(of([]));
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(DbConnectionsComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should load connections on init', async () => {
    apiService.getDbConnections.and.returnValue(of([
      { id: 'c1', dbType: 'postgres', poolSize: 10 },
    ]));

    const fixture = TestBed.createComponent(DbConnectionsComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.connections.length).toBe(1);
  });

  it('should create a connection', async () => {
    apiService.getDbConnections.and.returnValue(of([{ id: 'c2' }]));
    apiService.createDbConnection.and.returnValue(of({}));

    const fixture = TestBed.createComponent(DbConnectionsComponent);
    fixture.componentInstance.newConn = { projectId: 'p1', dbType: 'postgres', poolSize: 10 };

    await fixture.componentInstance.create();

    expect(apiService.createDbConnection).toHaveBeenCalled();
  });

  it('should delete a connection', async () => {
    spyOn(window, 'confirm').and.returnValue(true);
    apiService.deleteDbConnection.and.returnValue(of({}));

    const fixture = TestBed.createComponent(DbConnectionsComponent);
    fixture.componentInstance.connections = [{ id: 'c1' }];

    await fixture.componentInstance.delete('c1');

    expect(fixture.componentInstance.connections.length).toBe(0);
  });

  it('should not delete when confirmation cancelled', async () => {
    spyOn(window, 'confirm').and.returnValue(false);

    const fixture = TestBed.createComponent(DbConnectionsComponent);
    fixture.componentInstance.connections = [{ id: 'c1' }];

    await fixture.componentInstance.delete('c1');

    expect(fixture.componentInstance.connections.length).toBe(1);
  });
});
