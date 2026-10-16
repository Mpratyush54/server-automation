import { Component, OnDestroy } from '@angular/core';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterModule],
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.css',
})
export class LandingComponent implements OnDestroy {
  installCopied = false;
  readonly installCommand =
    'curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash\nsudo platformctl provision';
  private copyTimer?: ReturnType<typeof setTimeout>;

  async copyInstallCommand() {
    const done = () => {
      this.installCopied = true;
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.installCopied = false;
      }, 2000);
    };
    try {
      await navigator.clipboard.writeText(this.installCommand);
      done();
    } catch {
      const element = document.createElement('textarea');
      element.value = this.installCommand;
      element.style.position = 'fixed';
      element.style.left = '-9999px';
      document.body.appendChild(element);
      element.select();
      try {
        if (document.execCommand('copy')) done();
      } finally {
        element.remove();
      }
    }
  }

  ngOnDestroy() {
    if (this.copyTimer) clearTimeout(this.copyTimer);
  }
}
