import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-oauth-authorize',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #0D0F14; color: #fff; font-family: sans-serif;">
      <div style="text-align: center; padding: 40px; background: #14171F; border: 1px solid #1C2030; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); max-width: 400px; width: 100%;">
        <span style="font-size: 3rem; margin-bottom: 20px; display: inline-block; animation: pulse 2s infinite;">⚡</span>
        <h2 style="margin: 0 0 10px 0; font-size: 1.5rem; color: #fff;">SSO Authentication</h2>
        <p style="color: #94a3b8; font-size: 0.9rem; margin-bottom: 24px; line-height: 1.5;">Redirecting you back to client application...</p>
        <div class="spinner"></div>
      </div>
    </div>
  `,
  styles: [`
    .spinner {
      border: 3px solid rgba(91, 110, 245, 0.1);
      border-top-color: #5b6ef5;
      border-radius: 50%;
      width: 36px;
      height: 36px;
      animation: spin 1s linear infinite;
      margin: 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
  `]
})
export class OauthAuthorizeComponent implements OnInit {
  constructor(private route: ActivatedRoute, private router: Router) {}

  ngOnInit() {
    const params = this.route.snapshot.queryParams;
    const token = localStorage.getItem('caps_auth_token');

    if (!token) {
      const returnUrl = this.router.serializeUrl(
        this.router.createUrlTree(['/oauth/authorize'], { queryParams: params })
      );
      this.router.navigate(['/login'], { queryParams: { returnUrl } });
      return;
    }

    const query = new URLSearchParams(params).toString();
    const origin = window.location.origin;
    const apiHost = origin.includes('localhost:4200') ? 'http://localhost:3000' : origin;
    
    window.location.href = `${apiHost}/api/oauth/authorize?token=${encodeURIComponent(token)}&${query}`;
  }
}
