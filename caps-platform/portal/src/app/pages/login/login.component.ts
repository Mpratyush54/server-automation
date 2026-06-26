import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent implements OnInit {
  email = '';
  errorMessage = '';

  demoAccounts = [
    { name: 'Admin', email: 'admin@caps.io', role: 'Admin' },
    { name: 'DevOps Boss', email: 'devops@caps.io', role: 'DevOps' },
    { name: 'Sarah Lead', email: 'sarah@caps.io', role: 'Tech Lead' },
    { name: 'John Dev', email: 'john@caps.io', role: 'Developer' }
  ];

  constructor(private auth: AuthService, private router: Router, private route: ActivatedRoute) {}

  ngOnInit() {
    // If user is already authenticated, send them to dashboard
    if (this.auth.getToken()) {
      this.router.navigate(['/dashboard']);
    }
  }

  async login(emailOverride?: string) {
    this.errorMessage = '';
    const loginEmail = emailOverride || this.email;
    if (!loginEmail) {
      this.errorMessage = 'Please enter an email address.';
      return;
    }

    try {
      await firstValueFrom(this.auth.login(loginEmail));
      const returnUrl = this.route.snapshot.queryParams['returnUrl'];
      if (returnUrl) {
        this.router.navigateByUrl(returnUrl);
      } else {
        this.router.navigate(['/dashboard']);
      }
    } catch (err: any) {
      this.errorMessage = err.error?.error || 'Authentication failed. Make sure to initialize demo users first.';
    }
  }

  loginWithGitLab() {
    // Simulate GitLab OAuth Flow by calling the backend Gitlab endpoint which redirects
    window.location.href = '/api/auth/gitlab';
  }
}
