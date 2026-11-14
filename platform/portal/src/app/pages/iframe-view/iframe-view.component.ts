import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';


@Component({
  selector: 'app-iframe-view',
  standalone: true,
  imports: [],
  template: `
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ title }}</h1>
        <p class="page-subtitle">{{ subtitle }}</p>
      </div>
      @if (openUrl) {
        <a class="btn btn-sm" [href]="openUrl" target="_blank" rel="noopener">Open in a new tab</a>
      }
    </div>
    <div class="ifv-frame">
      @if (safeUrl) {
        <iframe [src]="safeUrl" [title]="title"></iframe>
      }
    </div>
    `,
  styles: [`
    .ifv-frame {
      height: calc(100vh - 220px);
      min-height: 480px;
      overflow: hidden;
      border: 1px solid rgb(var(--line));
      border-radius: 10px;
      background: rgb(var(--surface));
    }
    .ifv-frame iframe { display: block; width: 100%; height: 100%; border: 0; }
  `]
})
export class IframeViewComponent implements OnInit {
  safeUrl?: SafeResourceUrl;
  /** Plain URL for the "open in a new tab" link. */
  openUrl = '';
  title = 'Grafana';
  subtitle = 'Dashboards for your cluster and apps, shown inside the portal.';
  private readonly destroyRef = inject(DestroyRef);

  constructor(private route: ActivatedRoute, private sanitizer: DomSanitizer) {}

  ngOnInit() {
    this.route.data.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(data => {
      let path = data['url'] || '/';
      if (data['title']) this.title = data['title'];
      if (data['subtitle']) this.subtitle = data['subtitle'];

      if (window.location.hostname === 'localhost') {
        const portMap: Record<string, string> = {
          '/grafana/': 'http://localhost:3000/grafana/',
          '/portainer/': 'http://localhost:9000'
        };
        const localHost = portMap[path];
        if (localHost) {
          path = localHost;
        }
      } else {
        const protocol = window.location.protocol;
        const host = window.location.host;
        path = `${protocol}//${host}${path}`;
      }

      this.openUrl = path;
      this.safeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(path);
    });
  }
}
