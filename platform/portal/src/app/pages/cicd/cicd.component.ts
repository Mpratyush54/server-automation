import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-cicd',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './cicd.component.html',
  styleUrl: './cicd.component.css'
})
export class CicdComponent {
  projectName = '';
  stack = 'nodejs';
  dockerfile: string | null = null;
  gitlabCi: string | null = null;
  helm: any = null;
  k8s: any = null;
  loading = false;

  constructor(private api: ApiService) {}

  async loadDockerfile() {
    this.loading = true;
    try {
      const r = await firstValueFrom(this.api.getDockerfile(this.stack)) as any;
      this.dockerfile = r.dockerfile;
    } catch {}
    this.loading = false;
  }

  async loadGitlabCi() {
    this.loading = true;
    try {
      const r = await firstValueFrom(this.api.getGitlabCiYml(this.projectName, this.stack)) as any;
      this.gitlabCi = r.yaml;
    } catch {}
    this.loading = false;
  }

  async loadHelm() {
    this.loading = true;
    try {
      this.helm = await firstValueFrom(this.api.getHelmChart(this.projectName, this.stack));
    } catch {}
    this.loading = false;
  }

  async loadK8s() {
    this.loading = true;
    try {
      this.k8s = await firstValueFrom(this.api.getK8sManifests(this.projectName));
    } catch {}
    this.loading = false;
  }
}
