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
  styleUrl: './site-page.css',
  template: `
    <app-site-header current="pricing"></app-site-header>
    <main class="sp" id="main">
      <section class="sp-hero">
        <div class="sp-frame">
          <h1 class="sp-display">Pricing</h1>
          <p class="sp-lede">Free for personal use. Teams and companies get an Enterprise license sized to their servers.</p>
        </div>
      </section>
      <section class="sp-section">
        <div class="sp-frame sp-plans">
          <article class="sp-card" aria-labelledby="plan-personal">
            <div class="sp-card-head"><h2 id="plan-personal">Personal</h2><span class="sp-price">Free</span></div>
            <p class="sp-text">For individuals: homelabs, learning, side projects and personal websites. Companies can evaluate Cairn for 60 days.</p>
            <ul class="sp-list">
              <li>Up to 3 servers per install</li>
              <li>Up to 2 installs</li>
              <li>Every feature included</li>
            </ul>
            <div class="sp-actions"><a class="btn btn-primary" routerLink="/signup">Get a free key</a></div>
          </article>
          <article class="sp-card" id="enterprise" aria-labelledby="plan-enterprise">
            <div class="sp-card-head">
              <h2 id="plan-enterprise">Enterprise</h2>
              <span class="sp-price-line"><span class="sp-price">From $9</span><span class="sp-muted">per server per month, billed annually</span></span>
            </div>
            <p class="sp-text">For companies and organisations, and for anyone offering Cairn to others. Includes monitoring, logs, traces and support. Volume pricing by quote.</p>
            @if (sent) {
              <p class="sp-msg sp-ok" role="status" data-testid="quote-sent">Thanks, we'll reply within one business day.</p>
            } @else {
              <form class="sp-form sp-form-grid" novalidate (submit)="send($event)" data-testid="quote-form">
                <div class="sp-field">
                  <label for="q-company">Company</label>
                  <input id="q-company" name="company" required maxlength="200" autocomplete="organization" [attr.aria-invalid]="errors.company ? 'true' : null">
                  @if (errors.company) { <span class="sp-msg sp-err">{{ errors.company }}</span> }
                </div>
                <div class="sp-field">
                  <label for="q-name">Name</label>
                  <input id="q-name" name="name" required maxlength="200" autocomplete="name" [attr.aria-invalid]="errors.name ? 'true' : null">
                  @if (errors.name) { <span class="sp-msg sp-err">{{ errors.name }}</span> }
                </div>
                <div class="sp-field">
                  <label for="q-email">Work email</label>
                  <input id="q-email" name="email" type="email" required maxlength="254" autocomplete="email" [attr.aria-invalid]="errors.email ? 'true' : null">
                  @if (errors.email) { <span class="sp-msg sp-err">{{ errors.email }}</span> }
                </div>
                <div class="sp-field">
                  <label for="q-servers">Number of servers</label>
                  <input id="q-servers" name="servers" type="number" min="1" step="1" required inputmode="numeric" [attr.aria-invalid]="errors.servers ? 'true' : null">
                  @if (errors.servers) { <span class="sp-msg sp-err">{{ errors.servers }}</span> }
                </div>
                <div class="sp-field sp-wide">
                  <label for="q-message">Message</label>
                  <textarea id="q-message" name="message" maxlength="2000" [attr.aria-invalid]="errors.message ? 'true' : null"></textarea>
                  @if (errors.message) { <span class="sp-msg sp-err">{{ errors.message }}</span> }
                </div>
                <div class="sp-hp" aria-hidden="true">
                  <label for="q-website">Website</label>
                  <input id="q-website" name="website" tabindex="-1" autocomplete="off">
                </div>
                @if (formError) { <p class="sp-msg sp-err sp-wide" role="alert" data-testid="quote-error">{{ formError }}</p> }
                <div class="sp-actions sp-wide">
                  <button type="submit" class="btn btn-primary" [disabled]="busy">{{ busy ? 'Sending…' : 'Contact sales' }}</button>
                </div>
              </form>
            }
          </article>
        </div>
      </section>
    </main>
    <app-site-footer></app-site-footer>
  `,
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
