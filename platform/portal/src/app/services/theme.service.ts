import { Injectable, signal, DOCUMENT, inject } from '@angular/core';

/** 'system' follows the OS; 'light' / 'dark' override it. */
export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'platform.theme';

/**
 * Applies the chosen theme as data-theme on <html>. With 'system' the
 * attribute is removed and styles.css follows prefers-color-scheme.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  readonly choice = signal<ThemeChoice>(this.read());

  constructor() {
    this.apply(this.choice());
  }

  /** Cycle system -> light -> dark -> system (header toggle). */
  cycle(): void {
    const next: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
    this.set(next[this.choice()]);
  }

  set(choice: ThemeChoice): void {
    this.choice.set(choice);
    this.apply(choice);
    try {
      if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* storage blocked: the choice still applies for this session */
    }
  }

  /** The theme actually shown (resolves 'system'). */
  effective(): 'light' | 'dark' {
    const c = this.choice();
    if (c !== 'system') return c;
    return this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private apply(choice: ThemeChoice): void {
    const root = this.doc.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }

  private read(): ThemeChoice {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  }
}
