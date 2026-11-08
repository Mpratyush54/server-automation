import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { OperationProgressComponent } from './operation-progress.component';
import { ApiService } from '../services/api.service';

describe('OperationProgressComponent', () => {
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj('ApiService', ['getOperation']);
    await TestBed.configureTestingModule({
      imports: [OperationProgressComponent],
      providers: [{ provide: ApiService, useValue: api }],
    }).compileComponents();
  });

  function create(id: string) {
    const fixture = TestBed.createComponent(OperationProgressComponent);
    fixture.componentInstance.pollMs = 5;
    fixture.componentInstance.operationId = id;
    fixture.componentInstance.ngOnChanges({ operationId: { currentValue: id, previousValue: null, firstChange: true, isFirstChange: () => true } });
    return fixture;
  }

  it('polls until the operation is terminal and renders each step', async () => {
    api.getOperation.and.returnValues(
      of({ id: 'op1', status: 'running', progress: 33, attempts: 1, steps: [
        { name: 'apply', status: 'succeeded' }, { name: 'wait-healthy', status: 'running' }, { name: 'finalize', status: 'pending' },
      ] }),
      of({ id: 'op1', status: 'succeeded', progress: 100, attempts: 1, steps: [
        { name: 'apply', status: 'succeeded' }, { name: 'wait-healthy', status: 'succeeded' }, { name: 'finalize', status: 'succeeded' },
      ] }),
    );
    const fixture = create('op1');
    const finished = new Promise<any>((resolve) => fixture.componentInstance.finished.subscribe(resolve));
    const op = await finished;
    expect(op.status).toBe('succeeded');
    expect(api.getOperation).toHaveBeenCalledTimes(2);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('.op-steps li').length).toBe(3);
    expect(el.textContent).toContain('wait-healthy');
  });

  it('shows that an operation was resumed after a restart and surfaces errors', async () => {
    api.getOperation.and.returnValue(of({
      id: 'op2', status: 'failed', progress: 50, attempts: 2, error: 'apply: boom',
      steps: [{ name: 'apply', status: 'failed', error: 'boom' }, { name: 'finalize', status: 'pending' }],
    }));
    const fixture = create('op2');
    await new Promise<any>((resolve) => fixture.componentInstance.finished.subscribe(resolve));
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).toContain('resumed after restart');
    expect(text).toContain('apply: boom');
  });

  it('stops on 404', async () => {
    api.getOperation.and.returnValue(throwError(() => ({ status: 404 })));
    const fixture = create('missing');
    await new Promise((r) => setTimeout(r, 30));
    expect(api.getOperation).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.loadError).toBe('Operation not found');
  });
});
