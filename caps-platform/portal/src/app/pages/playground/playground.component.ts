import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';

interface ApiParameter {
  name: string;
  type: 'query' | 'body' | 'path';
  required: boolean;
  value: string;
  placeholder?: string;
  description?: string;
}

interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description: string;
  parameters: ApiParameter[];
  bodyTemplate?: string;
}

interface ApiGroup {
  name: string;
  endpoints: ApiEndpoint[];
}

@Component({
  selector: 'app-playground',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './playground.component.html',
  styleUrl: './playground.component.css'
})
export class PlaygroundComponent implements OnInit {
  groups: ApiGroup[] = [
    {
      name: 'Authentication & Users',
      endpoints: [
        {
          method: 'POST',
          path: '/api/auth/login',
          description: 'Authenticate user email and retrieve active JWT token.',
          parameters: [
            { name: 'email', type: 'body', required: true, value: 'john@caps.io', description: 'User login email address' }
          ]
        },
        {
          method: 'GET',
          path: '/api/users/init-demo',
          description: 'Register standard Developer, Tech Lead, and DevOps demo users in PostgreSQL.',
          parameters: []
        },
        {
          method: 'GET',
          path: '/api/users',
          description: 'Retrieve a list of all registered portal users (restricted to DevOps/Tech Lead).',
          parameters: []
        },
        {
          method: 'POST',
          path: '/api/users',
          description: 'Create a new user profile (restricted to DevOps).',
          parameters: [
            { name: 'name', type: 'body', required: true, value: 'New Developer' },
            { name: 'email', type: 'body', required: true, value: 'newdev@caps.io' },
            { name: 'role', type: 'body', required: true, value: 'developer', description: 'developer, tech_lead, or devops' },
            { name: 'gitlabId', type: 'body', required: false, value: '' }
          ]
        }
      ]
    },
    {
      name: 'Projects Engine',
      endpoints: [
        {
          method: 'GET',
          path: '/api/projects',
          description: 'Retrieve all projects including their environment lists and deployment histories.',
          parameters: []
        },
        {
          method: 'POST',
          path: '/api/projects',
          description: 'Provision a new project and initialize staging/production environments (restricted to DevOps/Tech Lead).',
          parameters: [
            { name: 'name', type: 'body', required: true, value: 'payment-gateway' },
            { name: 'stack', type: 'body', required: true, value: 'nodejs', description: 'nodejs, angular, python, static' },
            { name: 'repositoryUrl', type: 'body', required: true, value: 'https://gitlab.caps.io/payments/gateway.git' }
          ]
        },
        {
          method: 'GET',
          path: '/api/projects/:id',
          description: 'Retrieve detailed config, metadata, environments, and deployments for a specific project.',
          parameters: [
            { name: 'id', type: 'path', required: true, value: '', placeholder: 'Project UUID' }
          ]
        }
      ]
    },
    {
      name: 'Deployment Engine',
      endpoints: [
        {
          method: 'POST',
          path: '/api/deploy',
          description: 'Trigger a deployment to Kubernetes. Automatically creates preview instances if branch contains task tags.',
          parameters: [
            { name: 'projectId', type: 'body', required: true, value: '' },
            { name: 'environmentId', type: 'body', required: false, value: '', description: 'Empty for preview deployment creation' },
            { name: 'environmentName', type: 'body', required: false, value: 'preview', description: 'preview, staging, or production' },
            { name: 'version', type: 'body', required: true, value: '1.2.0' },
            { name: 'branch', type: 'body', required: true, value: 'feature/CU-842-payment-auth' },
            { name: 'commitSha', type: 'body', required: true, value: 'd3f23a1a' }
          ]
        },
        {
          method: 'POST',
          path: '/api/rollback',
          description: 'Rollback environment deployment to a previous release tag (restricted to DevOps/Tech Lead).',
          parameters: [
            { name: 'deploymentId', type: 'body', required: true, value: '' },
            { name: 'previousVersion', type: 'body', required: false, value: '1.1.0' }
          ]
        }
      ]
    },
    {
      name: 'Bootstrap & Node Engine',
      endpoints: [
        {
          method: 'GET',
          path: '/api/bootstrap/status',
          description: 'Check connectivity status of central services like Prometheus, Loki, ArgoCD, and Infisical.',
          parameters: []
        },
        {
          method: 'GET',
          path: '/api/bootstrap/nodes',
          description: 'List all physical/virtual VPS nodes attached to the Hostinger KVM8 master cluster.',
          parameters: []
        },
        {
          method: 'GET',
          path: '/api/bootstrap/token',
          description: 'Generate a one-time provisioning join token for adding fresh VPS machines (restricted to DevOps).',
          parameters: []
        }
      ]
    },
    {
      name: 'Config & Storage Gateway',
      endpoints: [
        {
          method: 'GET',
          path: '/api/config',
          description: 'Load config key/values for a project and environment.',
          parameters: [
            { name: 'projectId', type: 'query', required: true, value: '' },
            { name: 'environmentId', type: 'query', required: false, value: '' }
          ]
        },
        {
          method: 'POST',
          path: '/api/config',
          description: 'Register or update configuration variables (restricted to DevOps/Tech Lead).',
          parameters: [
            { name: 'projectId', type: 'body', required: true, value: '' },
            { name: 'key', type: 'body', required: true, value: 'DATABASE_TIMEOUT' },
            { name: 'value', type: 'body', required: true, value: '5000' },
            { name: 'isSecret', type: 'body', required: false, value: 'false' }
          ]
        },
        {
          method: 'POST',
          path: '/api/storage/upload-url',
          description: 'Request a signed upload URL redirect path from MinIO, S3, or Google Drive.',
          parameters: [
            { name: 'projectId', type: 'body', required: true, value: '' },
            { name: 'fileName', type: 'body', required: true, value: 'invoice.pdf' },
            { name: 'category', type: 'body', required: true, value: 'uploads', description: 'certificates, media, or uploads' }
          ]
        }
      ]
    }
  ];

  selectedEndpoint: ApiEndpoint | null = null;
  
  // Custom execution state
  authToken = '';
  responseStatus: number | null = null;
  responseLatency: number | null = null;
  responseBody: any = null;
  executing = false;

  constructor(private http: HttpClient, private auth: AuthService) {}

  ngOnInit() {
    this.authToken = this.auth.getToken() || '';
    // Select first endpoint by default
    if (this.groups.length > 0 && this.groups[0].endpoints.length > 0) {
      this.selectEndpoint(this.groups[0].endpoints[0]);
    }
  }

  selectEndpoint(ep: ApiEndpoint) {
    this.selectedEndpoint = ep;
    this.responseStatus = null;
    this.responseLatency = null;
    this.responseBody = null;
  }

  getEndpointUrl(ep: ApiEndpoint): string {
    let url = ep.path;
    // Replace path variables in description preview
    for (const p of ep.parameters) {
      if (p.type === 'path' && p.value) {
        url = url.replace(`:${p.name}`, p.value);
      }
    }
    return url;
  }

  async executeRequest() {
    if (!this.selectedEndpoint) return;
    this.executing = true;
    this.responseStatus = null;
    this.responseLatency = null;
    this.responseBody = null;

    const ep = this.selectedEndpoint;
    let url = ep.path;
    
    // Resolve path parameters
    for (const p of ep.parameters) {
      if (p.type === 'path') {
        if (!p.value) {
          alert(`Path parameter "${p.name}" is required.`);
          this.executing = false;
          return;
        }
        url = url.replace(`:${p.name}`, encodeURIComponent(p.value));
      }
    }

    // Resolve query parameters
    const queryParams: string[] = [];
    for (const p of ep.parameters) {
      if (p.type === 'query' && p.value) {
        queryParams.push(`${p.name}=${encodeURIComponent(p.value)}`);
      }
    }
    if (queryParams.length > 0) {
      url += '?' + queryParams.join('&');
    }

    // Resolve body parameters
    let body: any = null;
    const bodyParams = ep.parameters.filter(p => p.type === 'body');
    if (bodyParams.length > 0) {
      body = {};
      for (const p of bodyParams) {
        // Cast string boolean/numbers if needed
        if (p.value === 'true') body[p.name] = true;
        else if (p.value === 'false') body[p.name] = false;
        else if (!isNaN(Number(p.value)) && p.value.trim() !== '') body[p.name] = Number(p.value);
        else body[p.name] = p.value;
      }
    }

    // Headers
    let headers = new HttpHeaders({
      'Content-Type': 'application/json'
    });
    if (this.authToken) {
      headers = headers.set('Authorization', `Bearer ${this.authToken}`);
    }

    const startTime = Date.now();
    try {
      let reqObs;
      if (ep.method === 'GET') {
        reqObs = this.http.get(url, { headers, observe: 'response' });
      } else if (ep.method === 'POST') {
        reqObs = this.http.post(url, body, { headers, observe: 'response' });
      } else if (ep.method === 'PUT') {
        reqObs = this.http.put(url, body, { headers, observe: 'response' });
      } else if (ep.method === 'DELETE') {
        reqObs = this.http.delete(url, { headers, observe: 'response' });
      } else {
        reqObs = this.http.patch(url, body, { headers, observe: 'response' });
      }

      const resp = await firstValueFrom(reqObs);
      this.responseLatency = Date.now() - startTime;
      this.responseStatus = resp.status;
      this.responseBody = resp.body;
    } catch (err: any) {
      this.responseLatency = Date.now() - startTime;
      this.responseStatus = err.status || 500;
      this.responseBody = err.error || { error: err.message };
    } finally {
      this.executing = false;
    }
  }

  getParametersByType(type: 'path' | 'query' | 'body'): ApiParameter[] {
    if (!this.selectedEndpoint) return [];
    return this.selectedEndpoint.parameters.filter(p => p.type === type);
  }
}
