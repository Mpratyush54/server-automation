import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-iframe-view',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div style="width: 100%; height: calc(100vh - 100px); background: #0D0F14; border-radius: 8px; overflow: hidden; border: 1px solid var(--border-subtle);">
      <iframe *ngIf="safeUrl" [src]="safeUrl" style="width: 100%; height: 100%; border: none;"></iframe>
    </div>
  `
})
export class IframeViewComponent implements OnInit {
  safeUrl?: SafeResourceUrl;

  constructor(private route: ActivatedRoute, private sanitizer: DomSanitizer) {}

  ngOnInit() {
    this.route.data.subscribe(data => {
      let path = data['url'] || '/';
      
      if (window.location.hostname === 'localhost') {
        const portMap: Record<string, string> = {
          '/argocd/': 'http://localhost:8080',
          '/grafana/': 'http://localhost:3000/grafana/',
          '/portainer/': 'http://localhost:9000',
          '/infisical/': 'http://localhost:8081'
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
      
      this.safeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(path);
    });
  }
}
