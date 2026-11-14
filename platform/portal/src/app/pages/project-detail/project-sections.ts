/**
 * Project page sections (#185) and the pure helpers the page and its section
 * components share: `?tab=` deep-link mapping and truthful status labels.
 */

export type ProjectSection = 'overview' | 'deployments' | 'configuration' | 'data' | 'monitoring' | 'settings';

export const PROJECT_SECTIONS: { id: ProjectSection; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'data', label: 'Data' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'settings', label: 'Settings' },
];

/** Old tab names (before #185) and the section that now holds them. */
const LEGACY_TABS: Record<string, ProjectSection> = {
  deployments: 'deployments',
  gitops: 'deployments',
  environments: 'deployments',
  environment: 'configuration',
  config: 'configuration',
  secrets: 'configuration',
  metrics: 'monitoring',
  'api-metrics': 'monitoring',
  logs: 'monitoring',
  storage: 'data',
  databases: 'data',
  access: 'settings',
  'sdk-tokens': 'settings',
  privacy: 'settings',
};

/** Panel inside a section that an old tab pointed at, so bookmarks land on it. */
const LEGACY_ANCHORS: Record<string, string> = {
  gitops: 'gitops',
  environments: 'environments',
  metrics: 'metrics',
  'api-metrics': 'api-latency',
  logs: 'logs',
  storage: 'storage',
  databases: 'databases',
  access: 'access',
  'sdk-tokens': 'sdk-tokens',
  privacy: 'privacy',
};

/** Monitoring view (`?view=`) an old monitoring tab now lives in. */
const LEGACY_VIEWS: Record<string, string> = {
  metrics: 'resources',
  'api-metrics': 'traces',
  logs: 'logs',
};

/** Monitoring view for an old `?tab=` value (metrics, api-metrics, logs), or null. */
export function monitoringViewForTab(tab: string | null | undefined): string | null {
  const key = String(tab ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEGACY_VIEWS, key) ? LEGACY_VIEWS[key] : null;
}

/** Map any `?tab=` value (current section id or a pre-#185 tab name) to a section. Unknown -> overview. */
export function sectionForTab(tab: string | null | undefined): ProjectSection {
  const key = String(tab ?? '').trim().toLowerCase();
  if (!key) return 'overview';
  if (PROJECT_SECTIONS.some((s) => s.id === key)) return key as ProjectSection;
  return Object.prototype.hasOwnProperty.call(LEGACY_TABS, key) ? LEGACY_TABS[key] : 'overview';
}

/** Element id to scroll to for an old `?tab=` value, or null. */
export function anchorForTab(tab: string | null | undefined): string | null {
  const key = String(tab ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEGACY_ANCHORS, key) ? LEGACY_ANCHORS[key] : null;
}

export type StatusTone = 'ok' | 'warn' | 'down' | 'info' | 'neutral';
export interface StatusView { label: string; tone: StatusTone }

/** `.status` modifier class for a tone. */
export function statusClass(tone: StatusTone): string {
  return tone === 'neutral' ? 'status' : `status status-${tone}`;
}

/**
 * Project lifecycle from the API (Project entity): `isActive` defaults to true
 * and `deletedAt` marks a soft delete. A missing `isActive` is not "archived".
 */
export function projectStatus(project: any): StatusView {
  if (project?.deletedAt) return { label: 'Deleted', tone: 'down' };
  if (project?.isActive === false) return { label: 'Archived', tone: 'neutral' };
  return { label: 'Active', tone: 'ok' };
}

/** Deployment status (DeploymentStatus enum in the API, plus the legacy `active`). */
export function deploymentStatus(status: string | null | undefined): StatusView {
  const s = String(status ?? '').toLowerCase();
  switch (s) {
    case 'deployed':
    case 'active':
      return { label: 'Deployed', tone: 'ok' };
    case 'pending':
      return { label: 'Pending', tone: 'info' };
    case 'building':
      return { label: 'Building', tone: 'info' };
    case 'deploying':
      return { label: 'Deploying', tone: 'info' };
    case 'failed':
      return { label: 'Failed', tone: 'down' };
    case 'rolled_back':
      return { label: 'Rolled back', tone: 'warn' };
    case 'terminated':
      return { label: 'Terminated', tone: 'neutral' };
    case 'expired':
      return { label: 'Expired', tone: 'neutral' };
    default:
      return { label: s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : 'Unknown', tone: 'neutral' };
  }
}

/** True for a deployment that is currently serving (the API's `deployed`, or legacy `active`). */
export function isLive(dep: any): boolean {
  const s = String(dep?.status ?? '').toLowerCase();
  return s === 'deployed' || s === 'active';
}

function depTime(dep: any): number {
  const t = new Date(dep?.deployedAt || dep?.createdAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Newest first by deployedAt / createdAt. */
export function sortDeployments(deployments: any[]): any[] {
  return [...(deployments || [])].sort((a, b) => depTime(b) - depTime(a));
}

/**
 * The deployment to show as "current" for an environment: the newest live one,
 * otherwise the newest attempt (so a failed first deploy is visible), or null.
 */
export function currentDeployment(deployments: any[], environmentId: string): any | null {
  const forEnv = sortDeployments(deployments).filter((d) => d.environmentId === environmentId);
  return forEnv.find(isLive) ?? forEnv[0] ?? null;
}
