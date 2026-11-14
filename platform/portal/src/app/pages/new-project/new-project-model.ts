/**
 * Pure helpers for the new project wizard: the draft the user fills in, per-step
 * validation, address previews and the list of API calls that create it.
 *
 * Everything here maps onto something the API can actually set:
 *   POST /projects                                  name, stack, description, repositoryUrl, gitRevision, domain
 *   (server)                                        creates development, staging and production environments
 *   POST /projects/:id/databases/provision          one PostgreSQL database per environment
 *   PUT  /projects/:id/environment/:key             variables and secrets (all environments or one)
 *   PUT  /projects/:id/privacy/consent-defaults     analytics / session replay defaults
 *   PUT  /projects/:id/privacy/scrubbing            hide visitor IP addresses
 *   POST /projects/:id/members                      project access with a role
 */

export type StackId = 'nodejs' | 'angular' | 'python' | 'static';
export type EnvName = 'development' | 'staging' | 'production';
export type MemberRole = 'owner' | 'devops' | 'developer' | 'viewer';
export type StepId = 'app' | 'code' | 'environments' | 'data' | 'settings' | 'team' | 'review';

export const STACKS: { id: StackId; label: string; hint: string }[] = [
  { id: 'nodejs', label: 'Node.js', hint: 'A Node server such as Express, NestJS or a Next.js server.' },
  { id: 'angular', label: 'Angular', hint: 'An Angular app built and served as static files.' },
  { id: 'python', label: 'Python', hint: 'A Python service such as Django, Flask or FastAPI.' },
  { id: 'static', label: 'Static site', hint: 'Plain HTML, CSS and JavaScript, or any static build output.' },
];

/** The API always creates these three environments for a new project. */
export const ENVIRONMENTS: EnvName[] = ['development', 'staging', 'production'];

export const MEMBER_ROLES: { id: MemberRole; label: string; hint: string }[] = [
  { id: 'viewer', label: 'Viewer', hint: 'Sees the project, deployments and monitoring.' },
  { id: 'developer', label: 'Developer', hint: 'Also deploys and edits variables and secrets.' },
  { id: 'devops', label: 'DevOps', hint: 'Also changes project settings and databases.' },
  { id: 'owner', label: 'Owner', hint: 'Everything, including who has access.' },
];

export const STEPS: { id: StepId; label: string; title: string; optional?: boolean }[] = [
  { id: 'app', label: 'App', title: 'Name your app' },
  { id: 'code', label: 'Code', title: 'Connect the code', optional: true },
  { id: 'environments', label: 'Environments', title: 'Environments and addresses' },
  { id: 'data', label: 'Data', title: 'Databases', optional: true },
  { id: 'settings', label: 'Settings', title: 'Variables, secrets and privacy', optional: true },
  { id: 'team', label: 'Team', title: 'Who can work on it', optional: true },
  { id: 'review', label: 'Review', title: 'Review and create' },
];

/** Telemetry privacy defaults a new project starts with (TelemetryPrivacySettings). */
export const PRIVACY_DEFAULTS = { analytics: true, replay: false, scrubIps: true };

export interface VarRow { key: string; value: string; secret: boolean; scope: 'all' | EnvName }
export interface MemberRow { userId: string; email: string; role: MemberRole }

export interface WizardDraft {
  name: string;
  stack: StackId;
  description: string;
  repositoryUrl: string;
  gitRevision: string;
  domain: string;
  databases: Record<EnvName, boolean>;
  variables: VarRow[];
  privacy: { analytics: boolean; replay: boolean; scrubIps: boolean };
  members: MemberRow[];
}

export function emptyDraft(): WizardDraft {
  return {
    name: '',
    stack: 'nodejs',
    description: '',
    repositoryUrl: '',
    gitRevision: '',
    domain: '',
    databases: { development: false, staging: false, production: false },
    variables: [],
    privacy: { ...PRIVACY_DEFAULTS },
    members: [],
  };
}

export function emptyVar(): VarRow { return { key: '', value: '', secret: false, scope: 'all' }; }
export function emptyMember(): MemberRow { return { userId: '', email: '', role: 'developer' }; }

/** True when the user has typed or chosen anything worth asking about before leaving. */
export function isDirty(d: WizardDraft): boolean {
  const e = emptyDraft();
  return !!(d.name.trim() || d.description.trim() || d.repositoryUrl.trim() || d.gitRevision.trim() || d.domain.trim())
    || d.stack !== e.stack
    || ENVIRONMENTS.some((n) => d.databases[n])
    || d.variables.some((v) => v.key.trim() || v.value)
    || d.members.some((m) => m.userId || m.email.trim())
    || d.privacy.analytics !== e.privacy.analytics || d.privacy.replay !== e.privacy.replay || d.privacy.scrubIps !== e.privacy.scrubIps;
}

// ── Field validation (null = fine) ───────────────────────────────────────────

export const NAME_MAX = 40;

export function nameProblem(name: string, existing: string[]): string | null {
  const n = name.trim();
  if (!n) return 'Enter a name for the app.';
  if (n.length > NAME_MAX) return `Use at most ${NAME_MAX} characters.`;
  if (/[A-Z]/.test(n)) return 'Use lowercase letters only.';
  if (!/^[a-z0-9-]+$/.test(n)) return 'Use only lowercase letters, numbers and dashes.';
  if (n.startsWith('-') || n.endsWith('-')) return 'Start and end with a letter or number.';
  if (n.includes('--')) return 'Use single dashes between words.';
  if (existing.some((e) => String(e).toLowerCase() === n)) return `A project called ${n} already exists. Pick another name.`;
  return null;
}

export function parseRepo(url: string | null | undefined): { provider: string; host: string; ownerRepo: string } | null {
  const s = String(url || '').trim();
  if (!s) return null;
  let host = '';
  let path = '';
  const scp = /^git@([^:/\s]+):(.+)$/.exec(s);
  if (scp) { host = scp[1]; path = scp[2]; }
  else {
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      host = u.hostname;
      path = u.pathname;
    } catch { return null; }
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const parts = path.split('/').filter(Boolean);
  if (!host || parts.length < 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p))) return null;
  const h = host.toLowerCase();
  const provider = h.includes('github') ? 'GitHub' : h.includes('gitlab') ? 'GitLab' : 'Git';
  return { provider, host: h, ownerRepo: parts.join('/') };
}

export function repoProblem(url: string): string | null {
  if (!url.trim()) return null;
  if (!parseRepo(url)) return 'Enter the repository address, for example https://github.com/acme/shop or git@gitlab.com:acme/shop.git.';
  return null;
}

export function revisionProblem(rev: string): string | null {
  if (!rev) return null;
  if (!rev.trim() || /[\x00-\x20\x7f]/.test(rev)) return 'A branch name cannot contain spaces.';
  if (rev.length > 200) return 'Use at most 200 characters.';
  return null;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function domainProblem(domain: string): string | null {
  const d = domain.trim();
  if (!d) return null;
  if (/^[a-z]+:\/\//i.test(d) || d.includes('/')) return 'Enter only the domain, without https:// or a path.';
  if (/[A-Z]/.test(d)) return 'Use lowercase letters.';
  if (!HOST_RE.test(d)) return 'Enter a domain such as example.com or 203.0.113.7.sslip.io.';
  return null;
}

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/;

/** Rows that are completely empty are ignored. */
export function usedVars(rows: VarRow[]): VarRow[] {
  return rows.filter((r) => r.key.trim() || r.value);
}

export function varProblems(rows: VarRow[]): (string | null)[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    const key = r.key.trim();
    if (!key && !r.value) return null;
    if (!key) return 'Enter a name for this value.';
    if (!ENV_KEY_RE.test(key)) return 'Names start with a letter or underscore and use letters, numbers, _ . or -.';
    const id = `${key}|${r.scope}`;
    if (seen.has(id)) return `${key} is already set for ${r.scope === 'all' ? 'all environments' : r.scope}.`;
    seen.add(id);
    if (r.secret && !r.value) return 'Enter the secret value, or remove the row.';
    return null;
  });
}

export function usedMembers(rows: MemberRow[]): MemberRow[] {
  return rows.filter((m) => m.userId || m.email.trim());
}

export function memberProblems(rows: MemberRow[], selfId?: string | null): (string | null)[] {
  const seen = new Set<string>();
  return rows.map((m) => {
    const email = m.email.trim().toLowerCase();
    if (!m.userId && !email) return null;
    if (!m.userId && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Enter a valid email address.';
    if (selfId && m.userId === selfId) return 'You are added as the owner automatically.';
    const id = m.userId || email;
    if (seen.has(id)) return 'This person is already in the list.';
    seen.add(id);
    return null;
  });
}

/** First reason the step cannot be left with Next, or null when it is valid. */
export function stepProblem(step: StepId, d: WizardDraft, existing: string[], selfId?: string | null): string | null {
  switch (step) {
    case 'app': return nameProblem(d.name, existing);
    case 'code': return repoProblem(d.repositoryUrl) ? 'Fix the repository address, or clear it to connect one later.'
      : revisionProblem(d.gitRevision) ? 'Fix the branch name, or clear it to use the default branch.' : null;
    case 'environments': return domainProblem(d.domain) ? 'Fix the base domain, or clear it to set one later.' : null;
    case 'data': return null;
    case 'settings': return varProblems(d.variables).some(Boolean) ? 'Fix the highlighted variables, or remove those rows.' : null;
    case 'team': return memberProblems(d.members, selfId).some(Boolean) ? 'Fix the highlighted people, or remove those rows.' : null;
    case 'review': return null;
  }
}

/** Index of the first step with a problem, or -1 when everything is valid. */
export function firstInvalidStep(d: WizardDraft, existing: string[], selfId?: string | null): number {
  return STEPS.findIndex((s) => stepProblem(s.id, d, existing, selfId) !== null);
}

// ── Addresses ────────────────────────────────────────────────────────────────

/** Mirrors the API's projectSlug(). */
export function projectSlug(name: string): string {
  return String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * Preview of an environment's address. The API names each environment
 * `<slug, 24 chars>-<environment>-<16-char code from the project id>.<domain>`;
 * the code only exists once the project does, so the preview shows a placeholder.
 */
export function envHostPreview(name: string, env: EnvName, domain: string): string {
  const slug = projectSlug(name).slice(0, 24) || 'app';
  return `${slug}-${env}-<code>.${domain.trim() || '<server domain>'}`;
}

// ── Create plan ──────────────────────────────────────────────────────────────

export type PlanKind = 'project' | 'database' | 'variable' | 'consent' | 'scrubbing' | 'member';

export interface PlanItem {
  id: string;
  kind: PlanKind;
  label: string;
  env?: EnvName;
  variable?: VarRow;
  member?: MemberRow;
}

export function envLabel(scope: 'all' | EnvName): string {
  return scope === 'all' ? 'all environments' : scope;
}

/** API calls in the order they run. The project comes first; everything else needs its id. */
export function buildPlan(d: WizardDraft, userName: (id: string) => string = (id) => id): PlanItem[] {
  const plan: PlanItem[] = [{ id: 'project', kind: 'project', label: `Project ${d.name.trim()} with development, staging and production` }];
  for (const env of ENVIRONMENTS) {
    if (d.databases[env]) plan.push({ id: `db:${env}`, kind: 'database', env, label: `PostgreSQL database for ${env}` });
  }
  usedVars(d.variables).forEach((v, i) => {
    plan.push({ id: `var:${i}:${v.key.trim()}:${v.scope}`, kind: 'variable', variable: { ...v, key: v.key.trim() },
      label: `${v.secret ? 'Secret' : 'Variable'} ${v.key.trim()} for ${envLabel(v.scope)}` });
  });
  if (d.privacy.analytics !== PRIVACY_DEFAULTS.analytics || d.privacy.replay !== PRIVACY_DEFAULTS.replay) {
    plan.push({ id: 'consent', kind: 'consent', label: 'Privacy defaults for analytics and session replay' });
  }
  if (d.privacy.scrubIps !== PRIVACY_DEFAULTS.scrubIps) {
    plan.push({ id: 'scrubbing', kind: 'scrubbing', label: 'Keep visitor IP addresses' });
  }
  usedMembers(d.members).forEach((m, i) => {
    const who = m.userId ? userName(m.userId) : m.email.trim();
    plan.push({ id: `member:${i}:${m.userId || m.email.trim()}`, kind: 'member', member: { ...m, email: m.email.trim() }, label: `Access for ${who} as ${m.role}` });
  });
  return plan;
}
