import { Injectable, signal } from '@angular/core';

export type ToastTone = 'ok' | 'info' | 'warn' | 'down';

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  action?: { label: string; run: () => void };
}

export interface ConfirmOptions {
  title: string;
  /** One or two plain sentences: what will happen, and whether it can be undone. */
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action: the confirm button is red. */
  danger?: boolean;
  /** Ask the user to type this text before confirming (for irreversible deletes). */
  typeToConfirm?: string;
}

export interface PromptOptions {
  title: string;
  message?: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
}

interface OpenDialog {
  kind: 'confirm' | 'prompt' | 'alert';
  options: ConfirmOptions & Partial<PromptOptions>;
  resolve: (value: any) => void;
}

/**
 * In-app replacement for window.alert / confirm / prompt.
 *
 *   toast.ok('Saved')                         small notice, bottom right, auto-hides
 *   await dialog.confirm({ title, danger })   true / false
 *   await dialog.prompt({ title, label })     string or null
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private next = 1;

  show(text: string, tone: ToastTone = 'info', action?: Toast['action'], ms?: number): number {
    const id = this.next++;
    this.toasts.update((list) => [...list.slice(-3), { id, text, tone, action }]);
    // Errors stay longer; anything with an action stays until used or dismissed.
    const life = ms ?? (action ? 10_000 : tone === 'down' ? 8_000 : 4_000);
    setTimeout(() => this.dismiss(id), life);
    return id;
  }
  ok(text: string, action?: Toast['action']) { return this.show(text, 'ok', action); }
  info(text: string, action?: Toast['action']) { return this.show(text, 'info', action); }
  warn(text: string) { return this.show(text, 'warn'); }
  /** Errors: say what failed and, when known, what to do. */
  error(text: string) { return this.show(text, 'down'); }

  dismiss(id: number) {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}

@Injectable({ providedIn: 'root' })
export class DialogService {
  readonly current = signal<OpenDialog | null>(null);

  confirm(options: ConfirmOptions): Promise<boolean> {
    return this.open('confirm', options);
  }

  prompt(options: PromptOptions): Promise<string | null> {
    return this.open('prompt', { confirmLabel: 'OK', ...options });
  }

  /** A message that needs acknowledging (rare: prefer a toast). */
  alert(title: string, message?: string): Promise<void> {
    return this.open('alert', { title, message, confirmLabel: 'OK' });
  }

  /** Called by the dialog host. */
  close(value: any) {
    const d = this.current();
    this.current.set(null);
    d?.resolve(value);
  }

  private open<T>(kind: OpenDialog['kind'], options: OpenDialog['options']): Promise<T> {
    // A second dialog while one is open cancels the first.
    this.current()?.resolve(kind === 'prompt' ? null : false);
    return new Promise<T>((resolve) => this.current.set({ kind, options, resolve }));
  }
}

/** Plain error text from an HttpErrorResponse or Error. */
export function errorText(err: any, fallback = 'Something went wrong'): string {
  return err?.error?.error || err?.error?.message || (typeof err?.error === 'string' ? err.error : '') || err?.message || fallback;
}
