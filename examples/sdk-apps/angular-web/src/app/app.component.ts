import { Component } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { PlatformRumService } from '@mpratyush54/sdk-angular';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  template: `
    <h1>Angular client → Node API (Platform SDK)</h1>
    <nav><a routerLink="/">Home</a><a routerLink="/orders">Orders</a></nav>
    <router-outlet />
  `,
})
export class AppComponent {
  constructor(router: Router, rum: PlatformRumService) {
    // One RUM view per NavigationEnd: /orders/101 is recorded as /orders/:id.
    rum.trackRouter(router);
  }
}
