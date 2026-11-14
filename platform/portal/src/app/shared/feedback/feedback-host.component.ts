import { Component, ElementRef, HostListener, ViewChild, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogService, ToastService } from './feedback.service';

/** Renders toasts and the current dialog. Mounted once in the app shell. */
@Component({
  selector: 'app-feedback-host',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="fb-toasts" aria-live="polite" aria-atomic="false">
      @for (t of toast.toasts(); track t.id) {
        <div [class]="'fb-toast fb-' + t.tone" [attr.role]="t.tone === 'down' ? 'alert' : 'status'">
          <span class="fb-dot" aria-hidden="true"></span>
          <span class="fb-text">{{ t.text }}</span>
          @if (t.action) {
            <button type="button" class="fb-action" (click)="t.action.run(); toast.dismiss(t.id)">{{ t.action.label }}</button>
          }
          <button type="button" class="fb-close" (click)="toast.dismiss(t.id)" aria-label="Dismiss">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"></path></svg>
          </button>
        </div>
      }
    </div>

    @if (d(); as cur) {
      <div class="fb-backdrop" (click)="cancel()"></div>
      <div class="fb-dialog" role="dialog" aria-modal="true" [attr.aria-labelledby]="'fb-title'" [attr.aria-describedby]="cur.options.message ? 'fb-msg' : null">
        <form (ngSubmit)="ok()">
          <h2 id="fb-title">{{ cur.options.title }}</h2>
          @if (cur.options.message) { <p id="fb-msg" class="fb-msg">{{ cur.options.message }}</p> }
          @if (cur.kind === 'prompt') {
            <label class="fb-field">
              <span>{{ cur.options.label }}</span>
              <input #first name="value" [(ngModel)]="value" [placeholder]="cur.options.placeholder || ''" autocomplete="off">
            </label>
          }
          @if (cur.options.typeToConfirm) {
            <label class="fb-field">
              <span>Type <strong class="mono">{{ cur.options.typeToConfirm }}</strong> to confirm</span>
              <input #first name="typed" [(ngModel)]="typed" autocomplete="off" spellcheck="false">
            </label>
          }
          <div class="fb-actions">
            @if (cur.kind !== 'alert') {
              <button type="button" class="btn" (click)="cancel()">{{ cur.options.cancelLabel || 'Cancel' }}</button>
            }
            <button #primary type="submit" class="btn" [class.btn-primary]="!cur.options.danger" [class.btn-danger-solid]="cur.options.danger"
              [disabled]="!canConfirm()">{{ cur.options.confirmLabel || (cur.options.danger ? 'Delete' : 'Confirm') }}</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: [`
    .fb-toasts { position: fixed; right: 16px; bottom: 16px; z-index: 120; display: flex; flex-direction: column; gap: 8px; width: min(380px, calc(100vw - 32px)); pointer-events: none; }
    .fb-toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; padding: 10px 8px 10px 14px; background: rgb(var(--surface)); border: 1px solid rgb(var(--line-strong)); border-radius: 8px; box-shadow: 0 8px 24px rgb(0 0 0 / 0.16); font-size: 0.875rem; color: rgb(var(--fg)); animation: fb-in 160ms ease; }
    .fb-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: rgb(var(--info)); }
    .fb-ok .fb-dot { background: rgb(var(--ok)); }
    .fb-warn .fb-dot { background: rgb(var(--warn)); }
    .fb-down .fb-dot { background: rgb(var(--down)); }
    .fb-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .fb-action { flex: none; border: 0; background: none; color: rgb(var(--accent-text)); font: inherit; font-weight: 500; cursor: pointer; padding: 4px 6px; }
    .fb-action:hover { text-decoration: underline; }
    .fb-close { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: rgb(var(--fg-3)); cursor: pointer; }
    .fb-close:hover { background: rgb(var(--raised)); color: rgb(var(--fg)); }
    .fb-close svg { width: 12px; height: 12px; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }

    .fb-backdrop { position: fixed; inset: 0; z-index: 110; background: rgb(0 0 0 / 0.45); animation: fb-fade 120ms ease; }
    .fb-dialog { position: fixed; z-index: 111; left: 50%; top: 18vh; transform: translateX(-50%); width: min(440px, calc(100vw - 32px)); background: rgb(var(--surface)); border: 1px solid rgb(var(--line-strong)); border-radius: 10px; box-shadow: 0 16px 40px rgb(0 0 0 / 0.22); animation: fb-pop 140ms ease; }
    .fb-dialog form { padding: 20px; }
    .fb-dialog h2 { margin: 0; font-size: 1.0625rem; font-weight: 600; color: rgb(var(--fg)); }
    .fb-msg { margin: 8px 0 0; font-size: 0.875rem; line-height: 1.55; color: rgb(var(--fg-2)); }
    .fb-field { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; font-size: 0.875rem; color: rgb(var(--fg-2)); }
    .fb-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
    :host ::ng-deep .btn-danger-solid { background: rgb(var(--down)); border-color: transparent; color: #fff; }
    :host ::ng-deep .btn-danger-solid:hover { background: rgb(var(--down) / 0.88); }
    @keyframes fb-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes fb-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes fb-pop { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translateX(-50%); } }
    @media (prefers-reduced-motion: reduce) { .fb-toast, .fb-backdrop, .fb-dialog { animation: none; } }
  `],
})
export class FeedbackHostComponent {
  readonly toast = inject(ToastService);
  private readonly dialogs = inject(DialogService);
  readonly d = this.dialogs.current;
  value = '';
  typed = '';
  private returnFocus: HTMLElement | null = null;

  @ViewChild('first') first?: ElementRef<HTMLInputElement>;
  @ViewChild('primary') primary?: ElementRef<HTMLButtonElement>;

  canConfirm(): boolean {
    const cur = this.d();
    return !cur?.options.typeToConfirm || this.typed.trim() === cur.options.typeToConfirm;
  }

  constructor() {
    effect(() => {
      const cur = this.d();
      if (!cur) return;
      this.value = cur.options.value ?? '';
      this.typed = '';
      this.returnFocus = document.activeElement as HTMLElement | null;
      // Focus the field, or the safe button for destructive actions.
      setTimeout(() => (this.first?.nativeElement ?? this.primary?.nativeElement)?.focus());
    });
  }

  ok() {
    const cur = this.d();
    if (!cur) return;
    if (cur.options.typeToConfirm && this.typed.trim() !== cur.options.typeToConfirm) return;
    this.finish(cur.kind === 'prompt' ? this.value : true);
  }

  cancel() {
    const cur = this.d();
    if (!cur) return;
    this.finish(cur.kind === 'prompt' ? null : cur.kind === 'alert' ? undefined : false);
  }

  @HostListener('document:keydown.escape')
  onEscape() { if (this.d()) this.cancel(); }

  private finish(value: any) {
    this.dialogs.close(value);
    const back = this.returnFocus;
    this.returnFocus = null;
    setTimeout(() => back?.focus?.());
  }
}
