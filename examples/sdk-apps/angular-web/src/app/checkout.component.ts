import { Component } from '@angular/core';

/** Form with personal data: session replay must show every value masked (parity with react-web). */
@Component({
  selector: 'app-checkout',
  standalone: true,
  template: `
    <form (submit)="$event.preventDefault(); sent = true" style="display:grid;gap:8px;max-width:360px">
      <label>Full name <input name="name" data-testid="name" autocomplete="off" /></label>
      <label>E-mail <input name="email" type="email" data-testid="email" autocomplete="off" /></label>
      <label>Password <input name="password" type="password" data-testid="password" autocomplete="off" /></label>
      <label>Card number <input name="card" data-testid="card" autocomplete="off" inputmode="numeric" /></label>
      <label>Notes <textarea name="notes" data-testid="notes"></textarea></label>
      <p class="platform-mask" data-testid="masked-text">Account balance: 1234.56</p>
      <button type="submit" data-testid="submit">Place order</button>
      @if (sent) {
        <p data-testid="sent">Order placed.</p>
      }
    </form>
  `,
})
export class CheckoutComponent {
  sent = false;
}
