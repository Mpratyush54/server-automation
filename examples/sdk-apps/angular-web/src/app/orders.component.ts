import { Component } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiLog } from './api-log';

@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [RouterLink],
  template: `
    <ul>
      @for (id of ids; track id) {
        <li><a [routerLink]="['/orders', id]">Order {{ id }}</a></li>
      }
    </ul>
  `,
})
export class OrdersComponent {
  ids = [101, 102, 103];
}

@Component({
  selector: 'app-order-detail',
  standalone: true,
  template: `
    <h2>Order {{ id }}</h2>
    <button [disabled]="api.busy" (click)="api.hit('/api/users?order=' + id)">Load customer</button>
    <pre>{{ api.text || '—' }}</pre>
  `,
})
export class OrderDetailComponent {
  id: string | null;

  constructor(route: ActivatedRoute, public api: ApiLog) {
    this.id = route.snapshot.paramMap.get('id');
  }
}
