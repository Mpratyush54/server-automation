/**
 * Views inside a project's Monitoring section (`/projects/:id?tab=monitoring&view=…`).
 * The project page owns `tab`; the monitoring view lives in `view` so the two never clash.
 */
import { ProjectTab } from './observability-api';

export type MonitoringView = 'overview' | 'errors' | 'logs' | 'traces' | 'users' | 'uptime' | 'resources' | 'agents';

export const MONITORING_VIEWS: { id: MonitoringView; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'errors', label: 'Errors' },
  { id: 'logs', label: 'Logs' },
  { id: 'traces', label: 'Traces' },
  { id: 'users', label: 'Users' },
  { id: 'uptime', label: 'Uptime' },
  { id: 'resources', label: 'Resources' },
  { id: 'agents', label: 'AI agents' },
];

export function isMonitoringView(v: string | null | undefined): v is MonitoringView {
  return !!v && MONITORING_VIEWS.some((m) => m.id === v);
}

/** Old Observability page tab (`/projects/:id/observability?tab=…`) -> monitoring view. */
const OBS_TAB_VIEW: Record<ProjectTab, MonitoringView> = {
  overview: 'overview',
  apm: 'traces',
  traces: 'traces',
  logs: 'logs',
  errors: 'errors',
  rum: 'users',
  sessions: 'users',
  synthetics: 'uptime',
  infra: 'resources',
  profiles: 'resources',
};

export function viewForObsTab(tab: string | null | undefined): MonitoringView {
  const key = String(tab ?? '').trim().toLowerCase() as ProjectTab;
  return Object.prototype.hasOwnProperty.call(OBS_TAB_VIEW, key) ? OBS_TAB_VIEW[key] : 'overview';
}

/** Observability panels each monitoring view embeds (empty: the view has none). */
export const VIEW_OBS_TABS: Record<MonitoringView, ProjectTab[]> = {
  overview: ['overview'],
  errors: [],
  logs: ['logs'],
  traces: ['apm', 'traces'],
  users: ['rum'],
  uptime: [],
  resources: ['infra', 'profiles'],
  agents: [],
};
