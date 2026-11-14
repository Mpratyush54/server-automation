import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpContext, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { SKIP_SESSION_AUTH } from '../../services/auth.interceptor';
import { ToastService } from '../../shared/feedback/feedback.service';

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
      name: 'Sign-in and users',
      endpoints: [
        {
          method: 'POST',
          path: '/api/auth/login',
          description: 'Sign in with an email or username and password. Returns a session token, or an MFA challenge to finish with POST /api/auth/mfa/challenge when the account uses an authenticator app.',
          parameters: [
            { name: 'email', type: 'body', required: true, value: '', placeholder: 'you@example.com', description: 'Email address or username' },
            { name: 'password', type: 'body', required: true, value: '', placeholder: 'Account password', description: 'Account password' }
          ]
        },
        {
          method: 'GET',
          path: '/api/agent-tokens/me',
          description: 'Show who the token belongs to: an agent token (plat_agent_…) with its scopes, or the signed-in person for a session token.',
          parameters: []
        },
        {
          method: 'GET',
          path: '/api/users/me',
          description: 'Return the signed-in user\'s profile.',
          parameters: []
        },
        {
          method: 'GET',
          path: '/api/users',
          description: 'List every portal user. Admins, DevOps and tech leads only; agent tokens are refused.',
          parameters: []
        },
        {
          method: 'POST',
          path: '/api/users',
          description: 'Create a user who can sign in with the given password. Admins and DevOps only; agent tokens are refused.',
          parameters: [
            { name: 'name', type: 'body', required: true, value: 'New Developer' },
            { name: 'email', type: 'body', required: true, value: 'newdev@example.com' },
            { name: 'password', type: 'body', required: true, value: '', placeholder: 'At least 8 characters', description: 'At least 8 characters' },
            { name: 'role', type: 'body', required: false, value: 'developer', description: 'viewer, developer, tech_lead, devops or admin (default developer)' },
            { name: 'username', type: 'body', required: false, value: '', description: 'Defaults to the part of the email before @' }
          ]
        }
      ]
    },
    {
      name: 'Projects',
      endpoints: [
        {
          method: 'GET',
          path: '/api/projects',
          description: 'List the projects you can see, with their environments.',
          parameters: []
        },
        {
          method: 'POST',
          path: '/api/projects',
          description: 'Create a project with staging and production environments. Admins, DevOps and tech leads only.',
          parameters: [
            { name: 'name', type: 'body', required: true, value: 'payment-gateway' },
            { name: 'stack', type: 'body', required: true, value: 'nodejs', description: 'nodejs, angular, python or static' },
            { name: 'repositoryUrl', type: 'body', required: false, value: '', placeholder: 'https://github.com/acme/gateway', description: 'GitHub or GitLab repository; can be connected later' }
          ]
        },
        {
          method: 'GET',
          path: '/api/projects/:id',
          description: 'Get one project with its settings, environments and deployments.',
          parameters: [
            { name: 'id', type: 'path', required: true, value: '', placeholder: 'Project ID' }
          ]
        }
      ]
    },
    {
      name: 'Deployments',
      endpoints: [
        {
          method: 'POST',
          path: '/api/deploy',
          description: 'Deploy a version to an environment. Set environmentName to preview and leave environmentId empty to create a preview environment.',
          parameters: [
            { name: 'projectId', type: 'body', required: true, value: '' },
            { name: 'environmentId', type: 'body', required: false, value: '', description: 'Required unless environmentName is preview' },
            { name: 'environmentName', type: 'body', required: false, value: 'preview', description: 'preview, staging or production' },
            { name: 'version', type: 'body', required: true, value: '1.2.0' },
            { name: 'branch', type: 'body', required: true, value: 'feature/CU-842-payment-auth' },
            { name: 'commitSha', type: 'body', required: true, value: 'd3f23a1a' }
          ]
        },
        {
          method: 'POST',
          path: '/api/rollback',
          description: 'Roll an environment back to an earlier release. DevOps and tech leads only.',
          parameters: [
            { name: 'deploymentId', type: 'body', required: true, value: '' },
            { name: 'previousVersion', type: 'body', required: false, value: '1.1.0' }
          ]
        }
      ]
    },
    {
      name: 'Cluster',
      endpoints: [
        {
          method: 'GET',
          path: '/api/bootstrap/status',
          description: 'Check whether the platform services (Prometheus, Loki, Argo CD and others) are reachable.',
          parameters: []
        },
        {
          method: 'GET',
          path: '/api/bootstrap/nodes',
          description: 'List the cluster\'s nodes. DevOps, or an agent token with the cluster:read scope.',
          parameters: []
        },
        {
          method: 'GET',
          path: '/api/bootstrap/token',
          description: 'Get a join token for adding a new server to the cluster. DevOps only.',
          parameters: []
        }
      ]
    },
    {
      name: 'Config and storage',
      endpoints: [
        {
          method: 'GET',
          path: '/api/config',
          description: 'Load config keys and values for a project and environment.',
          parameters: [
            { name: 'projectId', type: 'query', required: true, value: '' },
            { name: 'environmentId', type: 'query', required: false, value: '' }
          ]
        },
        {
          method: 'POST',
          path: '/api/config',
          description: 'Add or update a config value. DevOps and tech leads only.',
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
          description: 'Get a signed upload URL for a file. Also accepts a server SDK token (sdk_live_… or sdk_test_…) for its own project.',
          parameters: [
            { name: 'projectId', type: 'body', required: true, value: '' },
            { name: 'fileName', type: 'body', required: true, value: 'invoice.pdf' },
            { name: 'category', type: 'body', required: true, value: 'uploads', description: 'certificates, media or uploads' }
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

  private toast = inject(ToastService);

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
          this.toast.warn(`Enter a value for the path parameter "${p.name}".`);
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
    // Send exactly the token in the form (or none, to test unauthenticated
    // calls): the session interceptor must not substitute the portal JWT.
    const context = new HttpContext().set(SKIP_SESSION_AUTH, true);

    const startTime = Date.now();
    try {
      let reqObs;
      if (ep.method === 'GET') {
        reqObs = this.http.get(url, { headers, context, observe: 'response' });
      } else if (ep.method === 'POST') {
        reqObs = this.http.post(url, body, { headers, context, observe: 'response' });
      } else if (ep.method === 'PUT') {
        reqObs = this.http.put(url, body, { headers, context, observe: 'response' });
      } else if (ep.method === 'DELETE') {
        reqObs = this.http.delete(url, { headers, context, observe: 'response' });
      } else {
        reqObs = this.http.patch(url, body, { headers, context, observe: 'response' });
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
