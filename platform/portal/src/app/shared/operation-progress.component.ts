import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../services/api.service';

const TERMINAL = new Set(['succeeded', 'failed', 'compensated']);

/**
 * Live progress of a multi-step operation (deploy, secret rotation, DB provisioning) from
 * GET /api/operations/:id. Polls until the operation is terminal.
 */
@Component({
  selector: 'app-operation-progress',
  standalone: true,
  imports: [],
  template: `
    @if (op) {
      <div class="op-progress" [attr.data-status]="op.status">
        <div class="op-head">
          <span class="badge" [class.badge-active]="op.status === 'succeeded'"
                [class.badge-pending]="op.status === 'running' || op.status === 'pending' || op.status === 'compensating'"
                [class.badge-failed]="op.status === 'failed' || op.status === 'compensated'">{{ op.status }}</span>
          <span class="op-title">{{ title || op.type }}</span>
          <span class="op-meta">{{ op.progress }}%@if (op.attempts > 1) {<span> · resumed after restart</span>}</span>
        </div>
        <div class="op-bar"><div class="op-bar-fill" [style.width.%]="op.progress"></div></div>
        <ol class="op-steps">
          @for (s of op.steps; track s.name) {
            <li [attr.data-step-status]="s.status">
              <span class="op-dot">{{ icon(s.status) }}</span>
              <span class="op-step-name">{{ s.name }}</span>
              @if (s.error) {
                <span class="op-step-error">{{ s.error }}</span>
              }
            </li>
          }
        </ol>
        @if (op.error && op.status !== 'succeeded') {
          <div class="op-error">{{ op.error }}</div>
        }
      </div>
    }
    @if (loadError) {
      <div class="op-error">{{ loadError }}</div>
    }
  `,
  styles: [`
    .op-progress { margin-top: 12px; padding: 12px; border: 1px solid var(--border-subtle, #333); border-radius: 8px; font-size: 0.78rem; }
    .op-head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .op-title { font-weight: 600; }
    .op-meta { margin-left: auto; color: var(--text-secondary, #a1a1aa); }
    .op-bar { height: 4px; background: rgba(255,255,255,0.08); border-radius: 2px; overflow: hidden; margin-bottom: 8px; }
    .op-bar-fill { height: 100%; background: var(--accent-success, #0070F3); transition: width .3s; }
    .op-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    .op-steps li { display: flex; gap: 8px; align-items: baseline; font-family: var(--font-code, monospace); }
    .op-dot { width: 14px; display: inline-block; text-align: center; }
    .op-step-error, .op-error { color: var(--accent-danger, #E00000); }
    .op-error { margin-top: 8px; }
  `],
})
export class OperationProgressComponent implements OnChanges, OnDestroy {
  @Input() operationId: string | null = null;
  @Input() title = '';
  @Input() pollMs = 2000;
  @Output() finished = new EventEmitter<any>();

  op: any = null;
  loadError = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private api: ApiService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['operationId']) {
      this.stop();
      this.op = null;
      this.loadError = '';
      if (this.operationId) void this.poll();
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stop();
  }

  icon(status: string): string {
    switch (status) {
      case 'succeeded': return '✓';
      case 'running': return '…';
      case 'failed': return '✕';
      case 'compensating':
      case 'compensated': return '↺';
      case 'skipped': return '–';
      default: return '·';
    }
  }

  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    const id = this.operationId;
    if (!id || this.destroyed) return;
    try {
      this.op = await firstValueFrom(this.api.getOperation(id));
      this.loadError = '';
    } catch (err: any) {
      // The API may be restarting (e.g. after a secret rotation); keep polling.
      this.loadError = err?.status === 404 ? 'Operation not found' : '';
      if (err?.status === 404) return;
    }
    if (id !== this.operationId || this.destroyed) return;
    if (this.op && TERMINAL.has(this.op.status)) {
      this.finished.emit(this.op);
      return;
    }
    this.timer = setTimeout(() => void this.poll(), this.pollMs);
  }
}
