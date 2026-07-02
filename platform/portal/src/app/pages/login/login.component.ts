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
  // Password mode fields
  username = '';
  password = '';
  showPassword = false;



  errorMessage = '';
  loading = false;

  constructor(private auth: AuthService, private router: Router, private route: ActivatedRoute) {}

  ngOnInit() {
    if (this.auth.getToken()) {
      this.router.navigate(['/dashboard']);
    }
  }

  async login() {
    this.errorMessage = '';
    this.loading = true;

    try {
      if (!this.username) {
        this.errorMessage = 'Please enter your username.';
        this.loading = false;
        return;
      }
      await firstValueFrom(this.auth.login('', this.password, this.username));

      const returnUrl = this.route.snapshot.queryParams['returnUrl'];
      if (returnUrl) {
        this.router.navigateByUrl(returnUrl);
      } else {
        this.router.navigate(['/dashboard']);
      }
    } catch (err: any) {
      this.errorMessage = err.error?.error || 'Authentication failed. Please check your credentials.';
    } finally {
      this.loading = false;
    }
  }

  loginWithGitLab() {
    window.location.href = '/api/auth/gitlab';
  }


}
