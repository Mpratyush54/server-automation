import { Component, OnInit, OnDestroy, Inject, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterModule } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.css'
})
export class LandingComponent implements OnInit, OnDestroy {
  activeSection = 'overview';
  private observer: IntersectionObserver | null = null;

  sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'setup', label: 'Setup Guide' },
    { id: 'auth', label: 'Authentication' },
    { id: 'api', label: 'API Reference' },
    { id: 'sdk', label: 'SDK Usage' },
    { id: 'rbac', label: 'Roles & Permissions' },
    { id: 'webhooks', label: 'Webhooks' },
  ];

  rawExamples: Record<string, string> = {};
  codeExamples: Record<string, SafeHtml> = {};
  copiedState: Record<string, boolean> = {};

  floatingCommands: Array<{ text: string, x: number, y: number, id: number, opacity: number, scale: number, angle: number }> = [];
  private particleId = 0;
  private lastX = 0;
  private lastY = 0;
  private commandList = [
    'kubectl get pods', 'git commit -m "feat: init"', 'docker-compose up -d', 
    'helm install platform ./charts', 'terraform apply', 'npm run dev', 'git push origin main', 
    'kubectl logs -f pod-abc', 'docker build -t platform-api .', 'curl -X POST /api/auth/login', 
    'git clone https://github.com/...', 'ng serve --port 4200', 'python app.py', 
    'pip install sdk-python', 'loki-stack', 'kubectl apply -f manifests/', 
    'npm install @platform/sdk-react', 'docker ps', 'kubectl get namespaces', 'git status'
  ];

  constructor(
    private sanitizer: DomSanitizer,
    @Inject(PLATFORM_ID) private platformId: Object
  ) {
    const raw: Record<string, string> = {};
    const langs: Record<string, string> = {};

    raw['node-install'] = 'npm install @mpratyush54/sdk-node';
    langs['node-install'] = 'bash';

    raw['python-install'] = 'pip install sdk-python';
    langs['python-install'] = 'bash';

    raw['react-install'] = 'npm install @platform/sdk-react';
    langs['react-install'] = 'bash';

    raw['angular-install'] = 'npm install @platform/sdk-angular';
    langs['angular-install'] = 'bash';

    raw['sdk-token'] = `sdk-{projectId}:{secret}`;
    langs['sdk-token'] = 'bash';

    raw['node-init'] = `const plat = require('@mpratyush54/sdk-node');

await plat.init({
  projectName: 'my-app',
  platformUrl: 'http://your-platform-server',
  environmentName: 'production',
});

// Attaches to Express — zero-overhead tracking
app.use(plat.expressMiddleware());
plat.captureConsole(); // forward all console.*

// Winston transport
const transport = plat.winstonTransport();
logger.add(transport);

// Pino destination
const dest = plat.pinoTransport();`;
    langs['node-init'] = 'javascript';

    raw['python-init'] = `from plat_sdk import PlatformClient

plat = PlatformClient()
plat.init(
    project_name="my-app",
    platform_url="http://your-platform-server:3000",
    environment_name="production",
)

# Postgres connection
pg = plat.postgres(host="localhost", port=5432, database="mydb")
await pg.connect()
await pg.execute("SELECT * FROM users")`;
    langs['python-init'] = 'python';

    raw['react-init'] = `import { PlatformProvider, ErrorBoundary, BugReporterWidget } from '@platform/sdk-react';

<PlatformProvider config={{ apiBase: 'http://localhost:3000', token: 'sdk-token', projectId: 'my-app' }}>
  <ErrorBoundary config={{ ... }}>
    <App />
  </ErrorBoundary>
  <BugReporterWidget config={{ ... }} />
</PlatformProvider>`;
    langs['react-init'] = 'javascript';

    raw['angular-init'] = `// app.module.ts
import { PlatformModule } from '@platform/sdk-angular';

&#64;NgModule({
  imports: [
    PlatformModule.forRoot({
      apiBase: 'http://localhost:3000',
      token: 'sdk-token',
      projectId: 'my-app',
    }),
  ],
})
export class AppModule {}`;
    langs['angular-init'] = 'javascript';

    raw['env-vars'] = `# Database
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=plat
POSTGRES_PASSWORD=plat
POSTGRES_DB=plat_platform

# MongoDB
MONGODB_URI=mongodb://localhost:27017/plat_platform

# Auth
JWT_SECRET=your-secret-key

# Integrations (optional)
GITLAB_API_URL=https://gitlab.com/api/v4
GITLAB_TOKEN=glpat-xxxxx
CLICKUP_API_TOKEN=pkxxxxx
GITHUB_TOKEN=ghp_xxxxx
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITLAB_WEBHOOK_SECRET=your-webhook-secret

# Portal
PORTAL_URL=http://localhost:4200`;
    langs['env-vars'] = 'env';

    raw['clone'] = `git clone https://github.com/your-org/platform.git
cd platform`;
    langs['clone'] = 'bash';

    raw['api-install'] = `cd api
npm install
npm run dev`;
    langs['api-install'] = 'bash';

    raw['portal-install'] = `cd portal
npm install
ng serve`;
    langs['portal-install'] = 'bash';

    raw['seed'] = `curl http://localhost:3000/api/users/init-demo`;
    langs['seed'] = 'bash';

    raw['login-curl'] = `curl -X POST http://localhost:3000/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email": "admin@@dev.io"}'`;
    langs['login-curl'] = 'bash';

    raw['login-response'] = `{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "00000000-0000-0000-0000-000000000001",
    "email": "admin@@dev.io",
    "name": "Admin",
    "role": "admin"
  }
}`;
    langs['login-response'] = 'json';

    raw['create-role'] = `POST /api/roles
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "database-admin",
  "description": "Can manage databases and backups only",
  "permissions": [
    "databases.provision",
    "databases.backup",
    "databases.restore",
    "databases.read"
  ]
}`;
    langs['create-role'] = 'javascript';

    raw['assign-role'] = `PATCH /api/users/:userId/role
Content-Type: application/json
Authorization: Bearer <token>

{
  "roleId": "role-uuid-here"
}`;
    langs['assign-role'] = 'javascript';

    raw['login-request'] = `POST /api/auth/login
Content-Type: application/json

{"email": "admin@@dev.io"}`;
    langs['login-request'] = 'javascript';

    raw['arch'] = `platform/
  ├── api/              # Express + TypeORM (PostgreSQL) + Mongoose (MongoDB)
  ├── portal/           # Angular 19 admin dashboard
  ├── sdk-node/    # Node.js SDK (auto-registration, metrics, logging)
  ├── sdk-python/  # Python SDK
  ├── sdk-react/   # React/Next.js SDK (interceptor, error boundary, bug reporter)
  ├── sdk-angular/ # Angular SDK (HTTP interceptor, error handler)
  └── platform-bootstrap/   # Cluster bootstrap script (k3s + Helm charts)`;
    langs['arch'] = 'plain';

    raw['register-webhook'] = `POST /api/cicd/register-webhook/:projectId
Authorization: Bearer <token>

# Auto-registers the webhook on GitHub/GitLab
# using the project's repositoryUrl and configured API token`;
    langs['register-webhook'] = 'bash';

    raw['wh-gh'] = `GITHUB_WEBHOOK_SECRET=your-secret    # HMAC key for GitHub signature verification
GITLAB_WEBHOOK_SECRET=your-secret    # Token for GitLab webhook verification
GITHUB_TOKEN=ghp_xxxxx               # For auto-registering webhooks on GitHub
GITLAB_TOKEN=glpat-xxxxx             # For auto-registering webhooks on GitLab`;
    langs['wh-gh'] = 'env';

    this.rawExamples = raw;

    for (const [key, val] of Object.entries(raw)) {
      const highlighted = this.highlightCode(val, langs[key] || 'plain');
      this.codeExamples[key] = this.sanitizer.bypassSecurityTrustHtml(highlighted);
    }
  }

  highlightCode(code: string, language: string): string {
    let esc = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/{/g, '&#123;')
      .replace(/}/g, '&#125;');

    if (language === 'bash' || language === 'sh') {
      const regex = /(#.*)|(^\$\s+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b(?:curl|git|npm|ng|pip|cd|node)\b)/gm;
      esc = esc.replace(regex, (match: string, comment: string | undefined, prompt: string | undefined, str: string | undefined, cmd: string | undefined) => {
        if (comment !== undefined) return `<span class="t-comment">${comment}</span>`;
        if (prompt !== undefined) return `<span class="t-prompt">${prompt}</span>`;
        if (str !== undefined) return `<span class="t-string">${str}</span>`;
        if (cmd !== undefined) return `<span class="t-command">${cmd}</span>`;
        return match;
      });
    } else if (language === 'javascript' || language === 'typescript' || language === 'json') {
      const regex = /(\/\/.*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b(?:const|require|await|import|from|export|default|new|class|private|public|function|return|let|interface|implements)\b)|(\b\d+\b)/g;
      esc = esc.replace(regex, (match: string, comment: string | undefined, str: string | undefined, kw: string | undefined, num: string | undefined) => {
        if (comment !== undefined) return `<span class="t-comment">${comment}</span>`;
        if (str !== undefined) return `<span class="t-string">${str}</span>`;
        if (kw !== undefined) return `<span class="t-keyword">${kw}</span>`;
        if (num !== undefined) return `<span class="t-number">${num}</span>`;
        return match;
      });
    } else if (language === 'python') {
      const regex = /(#.*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b(?:import|from|as|await|def|return|class|self|and|or|not)\b)/g;
      esc = esc.replace(regex, (match: string, comment: string | undefined, str: string | undefined, kw: string | undefined) => {
        if (comment !== undefined) return `<span class="t-comment">${comment}</span>`;
        if (str !== undefined) return `<span class="t-string">${str}</span>`;
        if (kw !== undefined) return `<span class="t-keyword">${kw}</span>`;
        return match;
      });
    } else if (language === 'env') {
      const regex = /(#.*)|(^([A-Z0-9_]+)=([^#\n\r]*))/gm;
      esc = esc.replace(regex, (match: string, comment: string | undefined, fullVar: string | undefined, varName: string | undefined, varValue: string | undefined) => {
        if (comment !== undefined) return `<span class="t-comment">${comment}</span>`;
        if (fullVar !== undefined) return `<span class="t-keyword">${varName}</span>=<span class="t-string">${varValue}</span>`;
        return match;
      });
    }

    return `<span class="lang-${language}" style="display:block;">${esc}</span>`;
  }

  copyCode(key: string) {
    const text = this.rawExamples[key];
    if (text && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      this.copiedState[key] = true;
      setTimeout(() => {
        this.copiedState[key] = false;
      }, 1500);
    }
  }

  ngOnInit() {
    if (isPlatformBrowser(this.platformId)) {
      // Small timeout to let elements render before setting up scroll spy
      setTimeout(() => this.setupScrollSpy(), 100);
    }
  }

  ngOnDestroy() {
    if (this.observer) {
      this.observer.disconnect();
    }
  }

  onMouseMove(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const dist = Math.hypot(x - this.lastX, y - this.lastY);
    if (dist > 100) {
      this.lastX = x;
      this.lastY = y;
      this.spawnCommandParticle(x, y);
    }
  }

  spawnCommandParticle(clientX: number, clientY: number) {
    const text = this.commandList[Math.floor(Math.random() * this.commandList.length)];
    const id = this.particleId++;
    const angle = (Math.random() - 0.5) * 20; // -10 to 10 deg
    const scale = 0.8 + Math.random() * 0.4;  // 0.8 to 1.2
    
    this.floatingCommands.push({
      text,
      x: clientX,
      y: clientY,
      id,
      opacity: 1,
      scale,
      angle
    });
    
    setTimeout(() => {
      this.floatingCommands = this.floatingCommands.filter(p => p.id !== id);
    }, 1500);
  }

  setupScrollSpy() {
    const options = {
      root: null, // relative to viewport
      rootMargin: '-10% 0px -75% 0px', // triggers when section is near the top
      threshold: 0
    };

    this.observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          this.activeSection = entry.target.id;
        }
      });
    }, options);

    this.sections.forEach((section) => {
      const el = document.getElementById(section.id);
      if (el && this.observer) {
        this.observer.observe(el);
      }
    });
  }

  setActive(id: string) {
    this.activeSection = id;
    const el = document.getElementById(id);
    if (el) {
      // Disconnect observer temporarily to prevent jumping during click scroll
      if (this.observer) this.observer.disconnect();

      el.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Reconnect observer after smooth scroll completes
      setTimeout(() => {
        if (isPlatformBrowser(this.platformId)) {
          this.setupScrollSpy();
        }
      }, 800);
    }
  }
}
