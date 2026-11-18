import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';

export type HowTab = 'deploy' | 'servers' | 'backups';

/**
 * "How it fits together" on the landing page: three small diagrams of how a
 * deploy flows, what runs on one server or three, and where backups go.
 * Every label follows the docs (deploy-your-app, builds, telemetry-ingestion,
 * operations/ha, operations/backups); change them together.
 */
@Component({
  selector: 'app-landing-how',
  standalone: true,
  imports: [RouterModule],
  templateUrl: './landing-how.component.html',
  styleUrl: './landing-how.component.css',
})
export class LandingHowComponent {
  readonly tabs: { id: HowTab; label: string; short: string }[] = [
    { id: 'deploy', label: 'How a deploy flows', short: 'Deploys' },
    { id: 'servers', label: 'What runs on your servers', short: 'Servers' },
    { id: 'backups', label: 'Where backups go', short: 'Backups' },
  ];
  tab: HowTab = 'deploy';
}
