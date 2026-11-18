import { Component, inject } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';
import { ToastService } from '../../shared/feedback/feedback.service';
import { LicenseAccountService, QuoteRequest } from './license-account.service';

export type QuoteField = 'company' | 'name' | 'email' | 'servers' | 'message';
export type QuoteErrors = Record<QuoteField, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS: QuoteField[] = ['company', 'name', 'email', 'servers', 'message'];

export const noErrors = (): QuoteErrors => ({ company: '', name: '', email: '', servers: '', message: '' });
export const hasErrors = (e: QuoteErrors) => FIELDS.some(k => !!e[k]);

/** Reads and checks the quote form. */
export function readQuote(form: FormData): { quote: QuoteRequest; errors: QuoteErrors } {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const quote: QuoteRequest = {
    company: text('company'),
    name: text('name'),
    email: text('email'),
    servers: Number(text('servers')),
    message: text('message'),
    website: text('website'),
  };
  const errors = noErrors();
  if (!quote.company) errors.company = 'Enter your company name.';
  if (!quote.name) errors.name = 'Enter your name.';
  if (!EMAIL.test(quote.email)) errors.email = 'Enter a valid work email.';
  if (!Number.isInteger(quote.servers) || quote.servers < 1 || quote.servers > 100000) errors.servers = 'Enter the number of servers.';
  if (quote.message.length > 2000) errors.message = 'Keep the message under 2000 characters.';
  return { quote, errors };
}

function pickFields(fields: unknown): QuoteErrors {
  const out = noErrors();
  if (!fields || typeof fields !== 'object') return out;
  for (const key of FIELDS) {
    const v = (fields as Record<string, unknown>)[key];
    if (typeof v === 'string' && v) out[key] = v;
  }
  return out;
}

@Component({
  selector: 'app-pricing',
  standalone: true,
  imports: [RouterModule, SiteHeaderComponent, SiteFooterComponent],
  styleUrls: ['./site-page.css', './pricing.component.css'],
  templateUrl: './pricing.component.html',
})
export class PricingComponent {
  private api = inject(LicenseAccountService);
  private toast = inject(ToastService);
  sent = false;
  busy = false;
  errors: QuoteErrors = noErrors();
  formError = '';

  async send(event: Event) {
    event.preventDefault();
    const { quote, errors } = readQuote(new FormData(event.target as HTMLFormElement));
    this.errors = errors;
    this.formError = '';
    if (hasErrors(errors)) return;
    this.busy = true;
    try {
      await this.api.requestQuote(quote);
      this.sent = true;
    } catch (e: any) {
      if (e?.status === 400) {
        this.errors = pickFields(e.fields);
        this.formError = hasErrors(this.errors) ? '' : (e.message || 'Check the form and try again.');
      } else if (e?.status === 429) {
        this.formError = 'Too many requests. Try again in a few minutes.';
      } else if (e?.code === 'network') {
        this.toast.error('Could not reach the server. Check your connection and try again.');
      } else {
        this.formError = 'Something went wrong. Try again, or email sales@cairnpaas.dev.';
      }
    } finally {
      this.busy = false;
    }
  }
}
