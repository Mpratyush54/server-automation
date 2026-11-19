import { Component, EventEmitter, HostListener, Input, OnChanges, OnDestroy, Output, SimpleChanges, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { StepUpService } from '../../services/step-up.service';
import { errorText } from '../../shared/feedback/feedback.service';

export type DeleteDialogResult = 'deleted' | 'cancelled' | 'left';
type Phase = 'loading' | 'confirm' | 'running' | 'failed' | 'deleted';

/** Plain labels for the steps of the API's project.delete operation. */
export function stepLabel(name: string, deleteDatabases: boolean): string {
  switch (name) {
    case 'prepare': return 'Hide the project and stop new deploys';
    case 'lock-databases': return 'Pause database connections';
    case 'back-up-databases': return 'Back up the databases';
    case 'stop-apps': return 'Stop the apps and previews';
    case 'remove-namespaces': return 'Remove the apps, web addresses and certificates';
    case 'remove-monitoring': return 'Remove checks, alerts and the status page';
    case 'revoke-access': return 'Revoke SDK tokens, secrets and variables';
    case 'remove-databases': return deleteDatabases ? 'Delete the databases' : 'Keep the databases, locked';
    case 'remove-data': return 'Delete logs, errors, replays and files';
    case 'finish': return 'Finish and free the name';
    default: return name;
  }
}

export interface DeleteStepView { name: string; label: string; status: string; note: string }

/**
 * Delete a project (DELETE /api/projects/:id): explains what goes, asks for the exact name and
 * a step-up code, then shows each step until the project is gone. A failed delete can be retried
 * from here; one that stopped before anything was removed can simply be started again.
 */
@Component({
  selector: 'app-delete-project-dialog',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (project) {
      <div class="pd-backdrop" (click)="close()"></div>
      <div class="pd-dialog" role="dialog" aria-modal="true" aria-labelledby="pd-title" data-testid="delete-project-dialog">
        @switch (phase) {
          @case ('loading') {
            <div class="pd-body"><h2 id="pd-title">Delete {{ project.name }}?</h2><p class="pd-msg">Checking the project…</p></div>
          }
          @case ('confirm') {
            <form class="pd-body" (ngSubmit)="start()">
              <h2 id="pd-title">Delete {{ project.name }}?</h2>
              @if (previousError) {
                <p class="pd-note" data-testid="pd-previous">The last try stopped before anything was deleted: {{ previousError }}</p>
              }
              <p class="pd-msg">This removes the project and everything it runs:</p>
              <ul class="pd-list">
                <li>Apps and previews, with their web addresses and certificates</li>
                <li>Builds and their images</li>
                <li>Checks, alerts and the status page</li>
                <li>SDK tokens, secrets and variables</li>
                <li>Logs, errors, replays, heatmaps and uploaded files</li>
              </ul>
              <p class="pd-msg">Every database is backed up first. If a backup fails, nothing is deleted. Deployment history and the audit log are kept, and the name can be used again.</p>
              <label class="pd-check">
                <input type="checkbox" name="deleteDatabases" [(ngModel)]="deleteDatabases" data-testid="pd-delete-dbs">
                <span>Also delete the databases (a backup is made first)</span>
              </label>
              @if (!deleteDatabases) {
                <p class="pd-hint">The databases are kept but locked, and where they are is written to the audit log.</p>
              }
              <label class="pd-field">
                <span>Type <strong class="mono">{{ project.name }}</strong> to confirm</span>
                <input name="typed" [(ngModel)]="typed" autocomplete="off" spellcheck="false" data-testid="pd-typed">
              </label>
              @if (error) { <p class="pd-error" role="alert" data-testid="pd-error">{{ error }}</p> }
              <div class="pd-actions">
                <button type="button" class="btn" (click)="close()">Cancel</button>
                <button type="submit" class="btn btn-danger-solid" [disabled]="!canConfirm() || busy" data-testid="pd-confirm">{{ busy ? 'Starting…' : 'Delete project' }}</button>
              </div>
            </form>
          }
          @default {
            <div class="pd-body">
              <h2 id="pd-title">
                @if (phase === 'deleted') { {{ project.name }} was deleted }
                @else if (phase === 'failed') { Deleting {{ project.name }} stopped }
                @else { Deleting {{ project.name }}… }
              </h2>
              <ol class="pd-steps" aria-live="polite" data-testid="pd-steps">
                @for (s of steps; track s.name) {
                  <li [attr.data-status]="s.status">
                    <span class="pd-dot" aria-hidden="true">{{ icon(s.status) }}</span>
                    <span class="pd-step">{{ s.label }}@if (s.note) { <span class="pd-step-note">{{ s.note }}</span> }</span>
                    <span class="sr-only">: {{ statusWord(s.status) }}</span>
                  </li>
                }
              </ol>
              @if (phase === 'failed') {
                <p class="pd-error" role="alert" data-testid="pd-error">{{ error || 'A step failed.' }} Some things are already removed, so the project stays hidden. Try again to finish.</p>
              }
              @if (phase === 'deleted') {
                <p class="pd-msg" data-testid="pd-done">{{ doneText }}</p>
              }
              @if (phase === 'running') {
                <p class="pd-hint">You can close this window. Deleting goes on in the background.</p>
              }
              <div class="pd-actions">
                @if (phase === 'failed') {
                  <button type="button" class="btn" (click)="close()">Close</button>
                  <button type="button" class="btn btn-danger-solid" (click)="retry()" [disabled]="busy" data-testid="pd-retry">{{ busy ? 'Starting…' : 'Try again' }}</button>
                } @else {
                  <button type="button" class="btn" [class.btn-primary]="phase === 'deleted'" (click)="close()" data-testid="pd-close">Close</button>
                }
              </div>
            </div>
          }
        }
      </div>
    }
  `,
  styles: [`
    .pd-backdrop { position: fixed; inset: 0; z-index: 110; background: rgb(0 0 0 / 0.45); }
    .pd-dialog { position: fixed; z-index: 111; left: 50%; top: 10vh; transform: translateX(-50%); width: min(520px, calc(100vw - 32px)); max-height: 80vh; overflow: auto; background: rgb(var(--surface)); border: 1px solid rgb(var(--line-strong)); border-radius: 10px; box-shadow: 0 16px 40px rgb(0 0 0 / 0.22); }
    .pd-body { padding: 20px; }
    .pd-dialog h2 { margin: 0; font-size: 1.0625rem; font-weight: 600; color: rgb(var(--fg)); }
    .pd-msg, .pd-list, .pd-hint, .pd-note { margin: 8px 0 0; font-size: 0.875rem; line-height: 1.55; color: rgb(var(--fg-2)); }
    .pd-list { padding-left: 20px; }
    .pd-hint { font-size: 0.8125rem; color: rgb(var(--fg-3)); }
    .pd-note { padding: 8px 10px; border-radius: 6px; background: rgb(var(--raised)); }
    .pd-check { display: flex; gap: 8px; align-items: flex-start; margin-top: 16px; font-size: 0.875rem; color: rgb(var(--fg)); }
    .pd-field { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; font-size: 0.875rem; color: rgb(var(--fg-2)); }
    .pd-error { margin: 12px 0 0; font-size: 0.875rem; color: rgb(var(--down)); }
    .pd-steps { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 6px; font-size: 0.875rem; }
    .pd-steps li { display: flex; gap: 8px; align-items: baseline; color: rgb(var(--fg-2)); }
    .pd-steps li[data-status="succeeded"] { color: rgb(var(--fg)); }
    .pd-steps li[data-status="failed"] { color: rgb(var(--down)); }
    .pd-dot { width: 16px; flex: none; text-align: center; }
    .pd-step-note { display: block; font-size: 0.8125rem; color: rgb(var(--fg-3)); }
    .pd-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
    .btn-danger-solid { background: rgb(var(--down)); border-color: transparent; color: #fff; }
    .btn-danger-solid:hover { background: rgb(var(--down) / 0.88); }
  `],
})
export class DeleteProjectDialogComponent implements OnChanges, OnDestroy {
  @Input() project: { id: string; name: string } | null = null;
  @Input() pollMs = 2000;
  @Output() closed = new EventEmitter<DeleteDialogResult>();

  private api = inject(ApiService);
  private stepUp = inject(StepUpService);

  phase: Phase = 'loading';
  typed = '';
  deleteDatabases = false;
  busy = false;
  error = '';
  previousError = '';
  steps: DeleteStepView[] = [];
  doneText = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['project']) {
      this.stop();
      this.reset();
      if (this.project) void this.loadStatus();
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stop();
  }

  @HostListener('document:keydown.escape')
  onEscape() { if (this.project && !this.busy) this.close(); }

  canConfirm(): boolean {
    return !!this.project && this.typed.trim() === this.project.name;
  }

  icon(status: string): string {
    switch (status) {
      case 'succeeded': return '✓';
      case 'running': return '…';
      case 'waiting': return '…';
      case 'failed': return '✕';
      case 'skipped': return '–';
      default: return '·';
    }
  }

  statusWord(status: string): string {
    switch (status) {
      case 'succeeded': return 'done';
      case 'running': return 'in progress';
      case 'waiting': return 'waiting';
      case 'failed': return 'failed';
      case 'skipped': return 'skipped';
      default: return 'not started';
    }
  }

  async start(): Promise<void> {
    if (!this.project || !this.canConfirm() || this.busy) return;
    await this.send();
  }

  async retry(): Promise<void> {
    if (!this.project || this.busy) return;
    await this.send();
  }

  close(): void {
    const result: DeleteDialogResult = this.phase === 'deleted' ? 'deleted' : this.phase === 'running' || this.phase === 'failed' ? 'left' : 'cancelled';
    this.stop();
    this.closed.emit(result);
  }

  private reset() {
    this.phase = 'loading';
    this.typed = '';
    this.deleteDatabases = false;
    this.busy = false;
    this.error = '';
    this.previousError = '';
    this.steps = [];
    this.doneText = '';
  }

  private async send(): Promise<void> {
    const project = this.project!;
    this.busy = true;
    this.error = '';
    try {
      await this.stepUp.run(
        () => firstValueFrom(this.api.deleteProject(project.id, { confirmName: project.name, deleteDatabases: this.deleteDatabases })),
        `Confirm it is you to delete ${project.name}`,
      );
      this.phase = 'running';
      await this.poll();
    } catch (err) {
      this.error = `The delete did not start: ${errorText(err)}`;
    } finally {
      this.busy = false;
    }
  }

  private async loadStatus(): Promise<void> {
    const id = this.project!.id;
    try {
      const view = await firstValueFrom(this.api.getProjectDeletion(id));
      if (id !== this.project?.id) return;
      this.apply(view, true);
    } catch {
      if (id === this.project?.id) this.phase = 'confirm';
    }
  }

  private async poll(): Promise<void> {
    const id = this.project?.id;
    if (!id || this.destroyed) return;
    try {
      const view = await firstValueFrom(this.api.getProjectDeletion(id));
      if (id !== this.project?.id || this.destroyed) return;
      this.apply(view, false);
    } catch {
      // The API may be restarting; keep polling.
    }
    if (this.phase === 'running' && !this.destroyed) {
      this.timer = setTimeout(() => void this.poll(), this.pollMs);
    }
  }

  private apply(view: any, initial: boolean) {
    const op = view?.operation;
    const deleteDatabases = view?.deleteDatabases === true;
    if (op?.steps) {
      this.steps = op.steps.map((s: any) => {
        const waiting = s.status === 'pending' && s.output?.waitingUntil;
        return {
          name: s.name,
          label: stepLabel(s.name, deleteDatabases),
          status: waiting ? 'waiting' : s.status,
          note: waiting ? 'Waiting for a running deploy or build to finish' : s.status === 'failed' && s.error ? String(s.error) : '',
        };
      });
    }
    switch (view?.status) {
      case 'running':
        this.phase = 'running';
        if (initial) void this.poll();
        break;
      case 'failed':
        this.phase = 'failed';
        this.deleteDatabases = deleteDatabases;
        this.error = op?.error ? String(op.error).replace(/^[a-z-]+: /, '') : '';
        break;
      case 'deleted': {
        this.phase = 'deleted';
        const backups = (op?.result?.backups || []).length;
        const dbs = op?.result?.databasesOutcome;
        this.doneText = backups
          ? `${backups} ${backups === 1 ? 'database was' : 'databases were'} backed up${dbs === 'dropped' ? ' and then deleted' : dbs === 'detached' ? ' and kept, locked' : ''}. The name can be used again.`
          : 'The name can be used again.';
        break;
      }
      case 'aborted':
        // Nothing was removed: start again from the confirmation.
        if (initial) {
          this.phase = 'confirm';
          this.previousError = op?.error ? String(op.error).replace(/^[a-z-]+: /, '') : '';
        } else {
          this.phase = 'confirm';
          this.error = op?.error ? String(op.error).replace(/^[a-z-]+: /, '') : 'The delete stopped before anything was removed.';
        }
        break;
      default:
        this.phase = 'confirm';
    }
  }

  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
