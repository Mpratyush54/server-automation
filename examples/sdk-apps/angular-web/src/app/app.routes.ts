import { Routes } from '@angular/router';
import { CheckoutComponent } from './checkout.component';
import { HomeComponent } from './home.component';
import { OrderDetailComponent, OrdersComponent } from './orders.component';
import { FeaturesComponent } from './features.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'orders', component: OrdersComponent },
  { path: 'orders/:id', component: OrderDetailComponent },
  { path: 'checkout', component: CheckoutComponent },
  { path: 'features', component: FeaturesComponent }, // heatmap demo (long page)
  { path: '**', redirectTo: '' },
];
