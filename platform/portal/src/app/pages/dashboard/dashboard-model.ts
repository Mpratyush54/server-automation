/**
 * Pure view-model helpers for the dashboard. The page answers three questions:
 * is anything wrong, how are my apps, and what happened recently.
 */

export type Tone = 'ok' | 'warn' | 'down' | 'neutral';

export interface AttentionItem {
  tone: 'warn' | 'down';
  text: string;
  action: string;
  link: string;
  query?: Record<string, string>;
  external?: boolean;
}

export interface AppEnv { name: string; tone: Tone; label: string }

export interface AppRow {
  id: string;
  name: string;
  tone: Tone;
  status: string;
  url: string | null;
  lastVersion: string | null;
  lastAt: string | null;
  lastBy: string | null;
  envs: AppEnv[];
  /** The project is being deleted (or a delete stopped and can be retried). */
  deleting?: boolean;
}

export interface ActivityItem {
  at: string;
  tone: Tone;
  text: string;
  detail: string;
  link: string;
  query?: Record<string, string>;
}

export interface ChecklistItem { id: string; label: string; hint: string; done: boolean; link: string; query?: Record<string, string> }

const LIVE = new Set(['deployed', 'active', 'success']);
const RUNNING = new Set(['pending', 'building', 'deploying', 'running']);

export function deploymentTone(status: string | undefined): Tone {
  const s = String(status || '').toLowerCase();
  if (LIVE.has(s)) return 'ok';
  if (RUNNING.has(s)) return 'warn';
  if (s === 'failed' || s === 'error') return 'down';
  return 'neutral';
}

export function deploymentWord(status: string | undefined): string {
  const s = String(status || '').toLowerCase();
  if (LIVE.has(s)) return 'Live';
  if (RUNNING.has(s)) return 'In progress';
  if (s === 'failed' || s === 'error') return 'Failed';
  if (s === 'rolled_back') return 'Rolled back';
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : 'Unknown';
}

const time = (d: any) => new Date(d?.deployedAt || d?.createdAt || 0).getTime() || 0;

function newestFirst<T>(list: T[]): T[] {
  return [...list].sort((a, b) => time(b) - time(a));
}

function who(d: any): string | null {
  const v = d?.deployedBy;
  if (!v) return null;
  if (typeof v === 'string') return v.split('@')[0];
  return v.name || (v.email ? String(v.email).split('@')[0] : null);
}

function envUrl(env: any, project: any): string | null {
  const host = env?.domain || (env?.name === 'production' ? project?.domain : null);
  if (!host) return null;
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

/** One row per app: overall status, live address and latest deployment. */
export function buildApps(projects: any[]): AppRow[] {
  return (projects || []).map((p) => {
    const deps = newestFirst<any>(p.deployments || []);
    const envs: AppEnv[] = (p.environments || []).map((e: any) => {
      const latest = deps.find((d) => d.environmentId === e.id || d.environment?.name === e.name);
      return latest
        ? { name: e.name, tone: deploymentTone(latest.status), label: deploymentWord(latest.status) }
        : { name: e.name, tone: 'neutral' as Tone, label: 'Not deployed' };
    });
    const prod = (p.environments || []).find((e: any) => e.name === 'production') || (p.environments || [])[0];
    const last = deps[0];
    const projectFailed = ['failed', 'error', 'degraded'].includes(String(p.status || '').toLowerCase());
    let tone: Tone = 'neutral';
    let status = 'Not deployed yet';
    if (projectFailed || envs.some((e) => e.tone === 'down')) { tone = 'down'; status = 'Needs attention'; }
    else if (envs.some((e) => e.tone === 'warn')) { tone = 'warn'; status = 'Deploying'; }
    else if (envs.some((e) => e.tone === 'ok') || (!deps.length && p.isActive !== false && p.status === 'active')) { tone = 'ok'; status = 'Running'; }
    if (p.deleting) { tone = 'warn'; status = 'Being deleted'; }
    return {
      id: p.id,
      name: p.name,
      tone,
      status,
      url: envUrl(prod, p) || (p.domain ? `https://${p.domain}` : null),
      lastVersion: last ? (last.version || String(last.commitSha || '').slice(0, 7) || null) : null,
      lastAt: last ? (last.deployedAt || last.createdAt || null) : null,
      lastBy: last ? who(last) : null,
      envs,
      ...(p.deleting ? { deleting: true } : {}),
    };
  }).sort((a, b) => rank(a.tone) - rank(b.tone) || a.name.localeCompare(b.name));
}

function rank(t: Tone): number { return t === 'down' ? 0 : t === 'warn' ? 1 : t === 'ok' ? 2 : 3; }

export interface AttentionInput {
  apps: AppRow[];
  incidents: any[];
  /** GET /settings/backups items; the backup item carries localOnly (#186). */
  backups: { operation: string; status: { success: boolean; finishedAt: string } | null; localOnly?: boolean }[] | null;
  k8sConnected: boolean | null;
  nodes: { name: string; status: string }[];
  update: { tag: string; url: string } | null;
}

/** Things a person should look at now, most serious first. */
export function buildAttention(i: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  if (i.k8sConnected === false) {
    out.push({ tone: 'down', text: 'The platform cannot reach the cluster, so apps and servers may not be shown correctly.', action: 'Check servers', link: '/infrastructure' });
  }
  for (const n of i.nodes.filter((n) => n.status !== 'Ready')) {
    out.push({ tone: 'down', text: `Server ${n.name} is not ready.`, action: 'Check servers', link: '/infrastructure' });
  }
  for (const a of i.apps.filter((a) => a.tone === 'down')) {
    const failed = a.envs.filter((e) => e.tone === 'down').map((e) => e.name);
    out.push({
      tone: 'down',
      text: failed.length ? `${a.name}: the last ${failed.join(' and ')} deployment failed.` : `${a.name} needs attention.`,
      action: 'Open deployments', link: `/projects/${a.id}`, query: { tab: 'deployments' },
    });
  }
  const open = (i.incidents || []).filter((x) => !['resolved', 'closed'].includes(String(x.status || '').toLowerCase()));
  if (open.length === 1) {
    out.push({ tone: open[0].severity === 'critical' ? 'down' : 'warn', text: `Open alert: ${open[0].title}.`, action: 'View alert', link: '/alerting' });
  } else if (open.length > 1) {
    const critical = open.filter((x) => x.severity === 'critical').length;
    out.push({ tone: critical ? 'down' : 'warn', text: `${open.length} open alerts${critical ? `, ${critical} critical` : ''}.`, action: 'View alerts', link: '/alerting' });
  }
  const backupItem = i.backups?.find((b) => b.operation === 'backup');
  const backup = backupItem?.status;
  if (backup && !backup.success) {
    out.push({ tone: 'down', text: 'The last backup failed.', action: 'See backups', link: '/settings' });
  }
  if (backupItem?.localOnly) {
    out.push({ tone: 'warn', text: 'Backups are stored only on this server.', action: 'Set up off-site backups', link: '/docs/operations/backups' });
  }
  for (const a of i.apps.filter((a) => a.tone === 'warn')) {
    out.push({ tone: 'warn', text: `${a.name} is deploying.`, action: 'Follow it', link: `/projects/${a.id}`, query: { tab: 'deployments' } });
  }
  if (i.update) {
    out.push({ tone: 'warn', text: `Platform ${i.update.tag} is available.`, action: 'See what changed', link: i.update.url, external: true });
  }
  return out;
}

/** Recent deployments and alerts across every app, newest first. */
export function buildActivity(projects: any[], incidents: any[], limit = 8): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const p of projects || []) {
    const envName = (d: any) => d.environment?.name || (p.environments || []).find((e: any) => e.id === d.environmentId)?.name || '';
    for (const d of p.deployments || []) {
      const version = d.version || String(d.commitSha || '').slice(0, 7);
      const env = envName(d);
      const word = deploymentWord(d.status).toLowerCase();
      const by = who(d);
      items.push({
        at: d.deployedAt || d.createdAt,
        tone: deploymentTone(d.status),
        text: `${p.name}${env ? ' ' + env : ''}: ${version || 'deployment'} ${word === 'live' ? 'is live' : word}`,
        detail: [d.commitMessage, by ? `by ${by}` : ''].filter(Boolean).join(' · '),
        link: `/projects/${p.id}`, query: { tab: 'deployments' },
      });
    }
  }
  const names = new Map((projects || []).map((p: any) => [p.id, p.name]));
  for (const x of incidents || []) {
    items.push({
      at: x.firstSeenAt || x.createdAt,
      tone: x.severity === 'critical' ? 'down' : 'warn',
      text: `Alert: ${x.title}`,
      detail: names.get(x.projectId) || '',
      link: '/alerting',
    });
  }
  return items.filter((i) => i.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

export interface ChecklistInput {
  projects: any[];
  mfaEnabled: boolean | undefined;
  userCount: number | null;
  backupOk: boolean | null;
}

/** Setup steps for a new install. Items whose state is unknown are left out. */
export function buildChecklist(i: ChecklistInput): ChecklistItem[] {
  const list: ChecklistItem[] = [
    { id: 'project', label: 'Create your first project', hint: 'A project is one app with its environments.', done: i.projects.length > 0, link: '/projects', query: { new: '1' } },
    { id: 'repo', label: 'Connect a Git repository', hint: 'Deployments come from your branches.', done: i.projects.some((p) => !!p.repositoryUrl), link: i.projects[0] ? `/projects/${i.projects[0].id}` : '/projects', query: i.projects[0] ? { tab: 'configuration' } : undefined },
    { id: 'deploy', label: 'Deploy an app', hint: 'Pick a branch and environment.', done: i.projects.some((p) => (p.deployments || []).length > 0), link: i.projects[0] ? `/projects/${i.projects[0].id}` : '/projects', query: i.projects[0] ? { tab: 'deployments' } : undefined },
  ];
  if (i.mfaEnabled !== undefined) list.push({ id: 'mfa', label: 'Turn on two-factor sign-in', hint: 'Protects your account with a second step.', done: i.mfaEnabled, link: '/profile' });
  if (i.userCount !== null) list.push({ id: 'team', label: 'Invite a teammate', hint: 'Give others their own account and role.', done: i.userCount > 1, link: '/users' });
  if (i.backupOk !== null) list.push({ id: 'backup', label: 'Check backups run', hint: 'A recent successful backup is shown here.', done: i.backupOk, link: '/settings' });
  return list;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a date. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} ${d === 1 ? 'day' : 'days'} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
