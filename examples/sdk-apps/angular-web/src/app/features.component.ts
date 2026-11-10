import { Component } from '@angular/core';

/**
 * Heatmap demo page: a long landing-style page with buttons in fixed places, so clicks
 * (x/y normalised to the document) and scroll depth produce a recognisable heatmap.
 */
@Component({
  selector: 'app-features',
  standalone: true,
  template: `
    <section class="hero">
      <h2>Ship faster with the Platform SDK</h2>
      <p>Clicks and scroll depth on this page feed the project's Heatmaps view.</p>
      <button id="cta-primary" data-rum-name="cta-primary" (click)="clicked = 'primary'">Start free trial</button>
      <button id="cta-secondary" (click)="clicked = 'secondary'">Book a demo</button>
    </section>
    @for (s of sections; track s.id) {
      <section class="block" [id]="'section-' + s.id">
        <h3>{{ s.title }}</h3>
        <p>{{ s.text }}</p>
        <button class="learn" [attr.data-rum-name]="'learn-' + s.id" (click)="clicked = s.id">Learn more</button>
      </section>
    }
    <footer class="foot">
      <button id="cta-footer" data-rum-name="cta-footer" (click)="clicked = 'footer'">Get started</button>
      <p>Last clicked: {{ clicked || '—' }}</p>
    </footer>
  `,
  styles: [`
    .hero { padding: 48px 16px; text-align: center; background: #eef2ff; border-radius: 8px; }
    .hero button { margin: 8px; padding: 12px 20px; }
    .block { min-height: 360px; padding: 24px 16px; border-bottom: 1px solid #e5e7eb; }
    .foot { padding: 48px 16px; text-align: center; }
  `],
})
export class FeaturesComponent {
  clicked = '';
  readonly sections = ['deploys', 'databases', 'observability', 'security', 'pricing'].map((id) => ({
    id,
    title: id[0].toUpperCase() + id.slice(1),
    text: 'Placeholder copy for the heatmap demo. Scroll down to increase the recorded scroll depth.',
  }));
}
