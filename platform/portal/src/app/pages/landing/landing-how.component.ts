import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';

/**
 * Three small diagrams on the landing page, drawn like the failover story in
 * the hero: how a deploy flows, what runs on your servers, where backups go.
 * Labels follow the docs (getting-started/deploy-your-app, operations/ha,
 * operations/backups); details belong in those guides, not here.
 */
@Component({
  selector: 'app-landing-how',
  standalone: true,
  imports: [RouterModule],
  templateUrl: './landing-how.component.html',
  styleUrl: './landing-how.component.css',
})
export class LandingHowComponent {}
