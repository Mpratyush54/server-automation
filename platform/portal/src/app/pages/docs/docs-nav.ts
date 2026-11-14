/**
 * Documentation navigation (#189): pages grouped by the task people come with.
 *
 * Every entry points at a Markdown file under docs/ (copied to public/docs),
 * so URLs stay the same as before: /docs/<section>/<page>, /docs/<page> for
 * files at the docs root, and /docs for docs/index.md. Grouping only changes
 * where a page appears in the sidebar, never its address.
 */

export interface DocPage {
  label: string;
  /** Folder under docs/ ('' for files at the docs root). */
  section: string;
  /** File name without .md ('' for docs/index.md). */
  page: string;
  /** Pages shown under this one when it, or one of them, is open. */
  children?: DocPage[];
  /** Small heading shown above this child in the sidebar (used to split SDKs). */
  heading?: string;
}

export interface DocGroup {
  label: string;
  id: string;
  pages: DocPage[];
}

const p = (label: string, path: string, extra: Partial<DocPage> = {}): DocPage => {
  const parts = path.split('/');
  const page = parts.pop() ?? '';
  return { label, section: parts.join('/'), page, ...extra };
};

export const DOC_GROUPS: DocGroup[] = [
  {
    label: 'Get started',
    id: 'get-started',
    pages: [
      p('What Platform is', ''),
      p('Install', 'getting-started/installation', {
        children: [
          p('What the installer does', 'deployment/bootstrap'),
          p('Domains and HTTPS', 'deployment/ssl-certificates'),
        ],
      }),
      p('Your first project', 'getting-started/first-project'),
      p('Deploy an app', 'getting-started/deploy-your-app', {
        children: [
          p('Preview environments', 'guides/preview-environments'),
          p('Connect GitHub or GitLab', 'guides/git-providers'),
          p('Branches and Argo CD', 'gitops-branches'),
          p('Production checklist', 'guides/production-checklist'),
        ],
      }),
    ],
  },
  {
    label: 'Guides',
    id: 'guides',
    pages: [
      p('Databases', 'guides/databases', {
        children: [
          p('Database monitoring', 'operations/database-monitoring'),
          p('File storage providers', 'operations/storage-providers'),
        ],
      }),
      p('Backups and restore', 'operations/backups', {
        children: [p('Manual backup procedures', 'deployment/backup-and-restore')],
      }),
      p('Monitoring and alerts', 'guides/monitoring', {
        children: [
          p('Observability views', 'guides/observability'),
          p('Alerts and on-call', 'operations/alerting'),
          p('Error tracking', 'observability/error-tracking'),
          p('Synthetic checks', 'operations/synthetics'),
          p('Status pages', 'guides/status-pages'),
          p('Frontend monitoring', 'guides/frontend-rum'),
          p('Heatmaps', 'guides/heatmaps'),
          p('Releases and comparisons', 'observability-releases'),
          p('Full-profile telemetry', 'operations/telemetry'),
          p('Privacy and retention', 'operations/telemetry-privacy'),
        ],
      }),
      p('High availability', 'operations/ha', {
        children: [p('Scaling', 'deployment/scaling')],
      }),
      p('Security and sign-in', 'guides/authentication', {
        children: [
          p('Two-factor sign-in', 'guides/mfa'),
          p('Secrets', 'guides/secrets-management'),
          p('Rotate cluster secrets', 'deployment/update-secrets'),
          p('Host hardening', 'host-hardening'),
          p('Namespace isolation', 'namespace-isolation'),
          p('Image signing', 'operations/image-signing'),
        ],
      }),
      p('AI agents and MCP', 'mcp/overview', {
        children: [
          p('Set up MCP', 'mcp/setup'),
          p('Tools and command policy', 'mcp/tools'),
          p('Rules for AI agents', 'mcp/for-agents'),
        ],
      }),
    ],
  },
  {
    label: 'Operations',
    id: 'operations',
    pages: [
      p('Upgrade', 'operations/upgrades', {
        children: [
          p('Bundled components', 'operations/platform-stack'),
          p('Rebuild and redeploy', 'deployment/rebuild-and-deploy'),
          p('Moving from Caps', 'getting-started/upgrade-guide'),
        ],
      }),
      p('Recover', 'operations/recover'),
      p('Troubleshooting', 'troubleshooting/README', {
        children: [
          p('apt lock', 'troubleshooting/apt-lock', { heading: 'Install' }),
          p('DNS or IPv6 timeout', 'troubleshooting/dns-ipv6-timeout'),
          p('DNS resolution', 'troubleshooting/general-dns-resolution'),
          p('sslip.io inside the cluster', 'troubleshooting/sslip-io-dns'),
          p('k3s port conflict', 'troubleshooting/k3s-port-conflict'),
          p('Docker Hub rate limit', 'troubleshooting/dockerhub-rate-limit'),
          p('Disk pressure', 'troubleshooting/disk-pressure'),
          p('GitHub Releases is down', 'troubleshooting/github-releases-outage'),
          p('ImagePullBackOff', 'troubleshooting/image-pull-backoff'),
          p('Helm name in use', 'troubleshooting/helm-name-reuse'),
          p('TypeScript build errors', 'troubleshooting/typescript-build-errors'),
          p('cert-manager timeout', 'troubleshooting/cert-manager-timeout', { heading: 'Ingress, HTTPS and sign-in' }),
          p('Ingress ownership', 'troubleshooting/ingress-ownership'),
          p('Portainer setup token', 'troubleshooting/portainer-setup-token'),
          p('Portainer OIDC certificate', 'troubleshooting/portainer-oidc-ssl'),
          p('Argo CD returns 404', 'troubleshooting/argocd-subpath-404'),
          p('Argo CD sign-in redirect', 'troubleshooting/argocd-oidc-redirect'),
          p('Grafana redirect', 'troubleshooting/grafana-subpath-redirect'),
          p('MinIO template error', 'troubleshooting/minio-template-error', { heading: 'Databases and storage' }),
          p('MinIO volume not found', 'troubleshooting/minio-pvc-not-found'),
          p('MongoDB validation', 'troubleshooting/mongodb-validation'),
          p('Wrong password after rotate', 'troubleshooting/db-wrongpass-after-rotate'),
          p('API seed failure', 'troubleshooting/api-seed-failure', { heading: 'API' }),
          p('Angular @ in templates', 'troubleshooting/angular-template-at-symbol'),
        ],
      }),
    ],
  },
  {
    label: 'Reference',
    id: 'reference',
    pages: [
      p('CLI', 'getting-started/platformctl'),
      p('API', 'api-reference/platform-api/auth', {
        children: [
          p('Users and roles', 'api-reference/platform-api/users'),
          p('Projects', 'api-reference/platform-api/projects'),
          p('Deployments', 'api-reference/platform-api/deployments'),
          p('Databases', 'api-reference/platform-api/databases'),
          p('Secrets', 'api-reference/platform-api/secrets'),
          p('Files', 'api-reference/platform-api/files'),
          p('Metrics', 'api-reference/platform-api/metrics'),
          p('Audit logs', 'api-reference/platform-api/audit-logs'),
          p('Webhooks', 'api-reference/platform-api/webhooks'),
          p('OAuth and OIDC', 'api-reference/platform-api/oauth'),
        ],
      }),
      p('Settings', 'api-reference/configuration/environment-variables', {
        children: [
          p('Permissions', 'api-reference/configuration/permissions'),
          p('Secrets encryption', 'api-reference/configuration/secrets-encryption'),
        ],
      }),
      p('SDKs', 'getting-started/sdk-examples', {
        children: [
          p('Quickstart', 'getting-started/node-sdk-quickstart', { heading: 'Node.js' }),
          p('PlatformClient', 'api-reference/sdk-node/PlatformClient'),
          p('Express middleware', 'api-reference/sdk-node/expressMiddleware'),
          p('Console capture', 'api-reference/sdk-node/captureConsole'),
          p('File storage', 'api-reference/sdk-node/storage'),
          p('PostgreSQL', 'api-reference/sdk-node/db-postgres'),
          p('MongoDB', 'api-reference/sdk-node/db-mongo'),
          p('Redis', 'api-reference/sdk-node/db-redis'),
          p('Quickstart', 'getting-started/react-sdk-quickstart', { heading: 'React' }),
          p('PlatformProvider', 'api-reference/sdk-react/PlatformProvider'),
          p('usePlatform', 'api-reference/sdk-react/usePlatform'),
          p('Bug reporter', 'api-reference/sdk-react/BugReporterWidget'),
          p('useBugReporter', 'api-reference/sdk-react/useBugReporter'),
          p('ErrorBoundary', 'api-reference/sdk-react/ErrorBoundary'),
          p('Quickstart', 'getting-started/angular-sdk-quickstart', { heading: 'Angular' }),
          p('PlatformModule', 'api-reference/sdk-angular/PlatformModule'),
          p('HTTP interceptor', 'api-reference/sdk-angular/PlatformHttpInterceptor'),
          p('Error handler', 'api-reference/sdk-angular/PlatformErrorHandler'),
          p('Bug reporter', 'api-reference/sdk-angular/BugReporterComponent'),
          p('Quickstart', 'getting-started/python-sdk-quickstart', { heading: 'Python' }),
          p('PlatformClient', 'api-reference/sdk-python/PlatformClient'),
          p('PostgreSQL', 'api-reference/sdk-python/db-postgres'),
          p('MongoDB', 'api-reference/sdk-python/db-mongo'),
          p('Redis', 'api-reference/sdk-python/db-redis'),
        ],
      }),
    ],
  },
  {
    label: 'More',
    id: 'more',
    pages: [
      p('How Platform works', 'architecture/overview', {
        children: [
          p('Request flow', 'architecture/data-flow'),
          p('Sign-in flow', 'architecture/auth-flow'),
          p('SDK lifecycle', 'architecture/sdk-lifecycle'),
          p('Secrets architecture', 'architecture/secrets-architecture'),
          p('Kubernetes layout', 'architecture/k8s-infrastructure'),
          p('Database schema', 'architecture/database-schema'),
          p('Network', 'architecture/network-topology'),
          p('Background jobs', 'architecture/background-jobs'),
          p('Telemetry ingestion', 'architecture/telemetry-ingestion'),
        ],
      }),
      p('FAQ', 'faq'),
      p('Changelog', 'changelog'),
      p('Contributing', 'contribution-guide', {
        children: [
          p('Repository layout', 'getting-started/project-structure'),
          p('Tests', 'guides/testing'),
          p('End-to-end CI', 'operations/e2e-ci'),
        ],
      }),
    ],
  },
];

/**
 * Short addresses that lead to a page (e.g. /docs/install). Old addresses
 * keep working on their own because no file moved; these are additions.
 * A folder name that is not a page (e.g. /docs/guides) still resolves to the
 * first page in that folder, as before.
 */
export const DOC_ALIASES: Record<string, string> = {
  'get-started': '/docs',
  guides: '/docs/guides/databases',
  operations: '/docs/operations/upgrades',
  reference: '/docs/getting-started/platformctl',
  install: '/docs/getting-started/installation',
  installation: '/docs/getting-started/installation',
  'first-project': '/docs/getting-started/first-project',
  deploy: '/docs/getting-started/deploy-your-app',
  databases: '/docs/guides/databases',
  backups: '/docs/operations/backups',
  restore: '/docs/operations/backups',
  monitoring: '/docs/guides/monitoring',
  alerts: '/docs/operations/alerting',
  ha: '/docs/operations/ha',
  'high-availability': '/docs/operations/ha',
  security: '/docs/guides/authentication',
  mcp: '/docs/mcp/overview',
  'ai-agents': '/docs/mcp/overview',
  upgrade: '/docs/operations/upgrades',
  recover: '/docs/operations/recover',
  troubleshooting: '/docs/troubleshooting/README',
  cli: '/docs/getting-started/platformctl',
  platformctl: '/docs/getting-started/platformctl',
  api: '/docs/api-reference/platform-api/auth',
  settings: '/docs/api-reference/configuration/environment-variables',
  sdks: '/docs/getting-started/sdk-examples',
};

/** All pages in reading order: each page, then its children. */
export function flattenPages(groups: DocGroup[] = DOC_GROUPS): DocPage[] {
  return groups.flatMap((g) => g.pages.flatMap((page) => [page, ...(page.children ?? [])]));
}

export function docUrl(page: Pick<DocPage, 'section' | 'page'>): string {
  if (!page.page) return '/docs';
  return page.section ? `/docs/${page.section}/${page.page}` : `/docs/${page.page}`;
}
