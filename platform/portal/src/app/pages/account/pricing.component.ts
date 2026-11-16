import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';
import { SALES_EMAIL } from './license-account.service';

export interface QuoteRequest { name: string; company: string; email: string; nodes: string; message: string }

/** Builds the mailto link for an Enterprise quote request. */
export function quoteMailto(q: QuoteRequest, to = SALES_EMAIL): string {
  const subject = `Cairn Enterprise quote${q.company ? ': ' + q.company : ''}`;
  const body = [`Name: ${q.name}`, `Company: ${q.company}`, `Email: ${q.email}`, `Servers: ${q.nodes}`, '', q.message].join('\n');
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

@Component({
  selector: 'app-pricing',
  standalone: true,
  imports: [FormsModule, RouterModule, SiteHeaderComponent, SiteFooterComponent],
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
            <div class="sp-card-head"><h2 id="plan-enterprise">Enterprise</h2><span class="sp-muted">Custom quote</span></div>
            <p class="sp-text">For companies and organisations, and for anyone offering Cairn to others. Server and install limits match your contract.</p>
            <form class="sp-form" (ngSubmit)="sendQuote()" #f="ngForm">
              <div class="sp-field"><label for="q-name">Name</label><input id="q-name" name="name" [(ngModel)]="quote.name" required autocomplete="name"></div>
              <div class="sp-field"><label for="q-company">Company</label><input id="q-company" name="company" [(ngModel)]="quote.company" required autocomplete="organization"></div>
              <div class="sp-field"><label for="q-email">Work email</label><input id="q-email" name="email" type="email" [(ngModel)]="quote.email" required email autocomplete="email"></div>
              <div class="sp-field"><label for="q-nodes">How many servers?</label><input id="q-nodes" name="nodes" [(ngModel)]="quote.nodes" inputmode="numeric"></div>
              <div class="sp-field"><label for="q-msg">Anything else</label><textarea id="q-msg" name="message" [(ngModel)]="quote.message"></textarea></div>
              <div class="sp-actions">
                <button type="submit" class="btn btn-primary" [disabled]="!f.valid">Contact sales</button>
                <span class="sp-muted">Opens your email app. Or write to <a [href]="'mailto:' + salesEmail">{{ salesEmail }}</a>.</span>
              </div>
            </form>
          </article>
        </div>
      </section>
    </main>
    <app-site-footer></app-site-footer>
  `,
})
export class PricingComponent {
  readonly salesEmail = SALES_EMAIL;
  quote: QuoteRequest = { name: '', company: '', email: '', nodes: '', message: '' };
  /** Replaced in tests. */
  open = (url: string) => { window.location.href = url; };

  sendQuote() {
    this.open(quoteMailto(this.quote));
  }
}
