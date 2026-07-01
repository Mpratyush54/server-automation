import { Component, Inject, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { CAPS_CONFIG, CapsConfig } from './caps-config';

interface ConsoleEntry {
  level: string;
  message: string;
  timestamp: string;
}

@Component({
  selector: 'caps-bug-reporter',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <button
      class="caps-bug-btn"
      (click)="toggle()"
      title="Report a bug"
    >🐛</button>

    <div class="caps-bug-drawer" *ngIf="isOpen">
      <div class="caps-bug-header">Report a Bug</div>
      <div *ngIf="sent" class="caps-bug-sent">
        Bug report submitted. Thank you!
      </div>
      <ng-container *ngIf="!sent">
        <div class="caps-bug-body">
          <textarea
            [(ngModel)]="description"
            placeholder="Describe the bug you encountered..."
            class="caps-bug-textarea"
          ></textarea>
          <div class="caps-bug-hint">
            Console logs and network history will be attached automatically.
          </div>
        </div>
        <div class="caps-bug-footer">
          <button class="caps-bug-cancel" (click)="toggle()">Cancel</button>
          <button
            class="caps-bug-submit"
            [disabled]="sending || !description.trim()"
            (click)="submit()"
          >{{ sending ? 'Submitting...' : 'Submit Report' }}</button>
        </div>
      </ng-container>
    </div>
  `,
  styles: [`
    .caps-bug-btn {
      position: fixed; bottom: 20px; right: 20px; z-index: 99999;
      width: 48px; height: 48px; border-radius: 50%;
      background: #dc2626; color: #fff; border: none; cursor: pointer;
      font-size: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: flex; align-items: center; justify-content: center;
    }
    .caps-bug-drawer {
      position: fixed; bottom: 80px; right: 20px; z-index: 99999;
      width: 380px; max-height: 500px; background: #1a1a2e; color: #e0e0e0;
      border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      font-family: system-ui, sans-serif; overflow: hidden;
      display: flex; flex-direction: column;
    }
    .caps-bug-header { padding: 16px; border-bottom: 1px solid #333; font-weight: 600; font-size: 14px; }
    .caps-bug-sent { padding: 40px 16px; text-align: center; color: #22c55e; }
    .caps-bug-body { padding: 16px; flex: 1; overflow: auto; }
    .caps-bug-textarea {
      width: 100%; min-height: 120px; padding: 10px; border-radius: 8px;
      border: 1px solid #444; background: #0f0f23; color: #e0e0e0;
      resize: vertical; font-family: inherit; font-size: 13px;
    }
    .caps-bug-hint { margin-top: 8px; font-size: 11px; color: #888; }
    .caps-bug-footer { padding: 12px 16px; border-top: 1px solid #333; display: flex; gap: 8px; }
    .caps-bug-cancel {
      flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #444;
      background: transparent; color: #ccc; cursor: pointer; font-size: 13px;
    }
    .caps-bug-submit {
      flex: 1; padding: 8px; border-radius: 6px; border: none;
      background: #dc2626; color: #fff; cursor: pointer; font-size: 13px;
    }
    .caps-bug-submit:disabled { opacity: 0.6; cursor: not-allowed; }
  `]
})
export class BugReporterComponent implements OnInit, OnDestroy {
  isOpen = false;
  description = '';
  sending = false;
  sent = false;

  private consoleLogs: ConsoleEntry[] = [];
  private origConsole = { log: console.log, warn: console.warn, error: console.error };
  private intervalId: any;

  constructor(
    @Inject(CAPS_CONFIG) private config: CapsConfig,
    private http: HttpClient,
  ) {}

  ngOnInit(): void {
    const capture = (level: string, ...args: any[]) => {
      this.consoleLogs.push({
        level,
        message: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
        timestamp: new Date().toISOString(),
      });
      if (this.consoleLogs.length > 100) this.consoleLogs.shift();
    };

    console.log = (...args: any[]) => { capture('log', ...args); this.origConsole.log.apply(console, args); };
    console.warn = (...args: any[]) => { capture('warn', ...args); this.origConsole.warn.apply(console, args); };
    console.error = (...args: any[]) => { capture('error', ...args); this.origConsole.error.apply(console, args); };
  }

  ngOnDestroy(): void {
    console.log = this.origConsole.log;
    console.warn = this.origConsole.warn;
    console.error = this.origConsole.error;
    if (this.intervalId) clearInterval(this.intervalId);
  }

  toggle(): void {
    this.isOpen = !this.isOpen;
  }

  submit(): void {
    if (!this.description.trim()) return;
    this.sending = true;

    this.http.post(`${this.config.apiBase}/api/sdk/bug-report`, {
      projectId: this.config.projectId,
      environment: this.config.environment || 'production',
      description: this.description,
      category: 'user-report',
      consoleLogs: [...this.consoleLogs],
      browserInfo: {
        userAgent: navigator.userAgent,
        url: window.location.href,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      },
    }).subscribe({
      next: () => {
        this.sent = true;
        setTimeout(() => { this.isOpen = false; this.sent = false; this.description = ''; }, 2000);
        this.sending = false;
      },
      error: () => {
        alert('Failed to submit bug report.');
        this.sending = false;
      },
    });
  }
}
