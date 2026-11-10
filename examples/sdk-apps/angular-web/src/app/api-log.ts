import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { API_BASE } from './api-base';

@Injectable({ providedIn: 'root' })
export class ApiLog {
  lines: string[] = [];
  busy = false;

  constructor(private http: HttpClient) {}

  hit(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): void {
    this.busy = true;
    const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}client=angular`;
    this.http.request(method, url, { body }).subscribe({
      next: (data) => this.push(`[angular] ${method} ${path} → 200 ${JSON.stringify(data).slice(0, 120)}`),
      error: (e) => this.push(`[angular] ERROR ${path}: ${e.status || ''} ${e.message}`),
    });
  }

  get text(): string {
    return this.lines.join('\n');
  }

  private push(line: string): void {
    this.lines = [line, ...this.lines].slice(0, 12);
    this.busy = false;
  }
}
