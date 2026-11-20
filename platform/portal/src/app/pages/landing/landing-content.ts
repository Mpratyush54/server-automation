/**
 * Facts the landing page states besides the feature clips. Every line here
 * must match the docs or a public release; nothing is fetched at runtime
 * (the CSP blocks the GitHub API, and it is rate limited).
 */

export const REPO_URL = 'https://github.com/Mpratyush54/server-automation';

/**
 * The latest stable release, as shown on GitHub Releases. Update it when a
 * new stable release (not a release candidate) becomes Latest.
 */
export const LATEST_RELEASE = {
  version: 'v2.0.2',
  /** ISO date for <time datetime>. */
  date: '2026-11-21',
  dateLabel: '21 November 2026',
};

/** One step of a "how it works" flow, drawn left to right (top to bottom on narrow screens). */
export interface FlowStep {
  name: string;
  detail: string;
}

/** What a feature section adds around its clip: the guide link wording, and an optional flow. */
export interface FeatureExtra {
  /** Link text for the feature's guide, written as a natural link. */
  more: string;
  flow: { label: string; steps: FlowStep[] } | null;
}

/**
 * Keyed by feature clip id (landing-clips.ts). The flows follow
 * getting-started/deploy-your-app, operations/ha and operations/backups.
 */
export const FEATURE_EXTRAS: Readonly<Record<string, FeatureExtra>> = {
  install: { more: 'How the install works', flow: null },
  'deploy-from-git': {
    more: 'How deploys work',
    flow: {
      label: 'git push, your CI builds the image, Cairn syncs your Kubernetes files, and the app is live',
      steps: [
        { name: 'git push', detail: 'to your branch' },
        { name: 'Your CI', detail: 'builds the image' },
        { name: 'Cairn', detail: 'syncs k8s/' },
        { name: 'Live', detail: 'over HTTPS' },
      ],
    },
  },
  observability: { more: 'How monitoring works', flow: null },
  backups: {
    more: 'How backups work',
    flow: {
      label: 'Your servers, an encrypted archive every night, your own bucket, and a restore test that checks it',
      steps: [
        { name: 'Servers', detail: 'data, settings' },
        { name: 'Encrypted', detail: 'every night' },
        { name: 'Your bucket', detail: 'any S3 store' },
        { name: 'Restore test', detail: 'checks it' },
      ],
    },
  },
  'high-availability': {
    more: 'How failover works',
    flow: {
      label: 'Start on one server, join two more, each keeps a copy, and when one fails the others take over',
      steps: [
        { name: 'One server', detail: 'runs it all' },
        { name: 'Join two', detail: 'more servers' },
        { name: 'Copies', detail: 'on each server' },
        { name: 'One fails', detail: 'others take over' },
      ],
    },
  },
  mcp: { more: 'How AI access works', flow: null },
};

/** Checkable facts, each with the page that explains it. */
export const PROOF_FACTS: { text: string; link: string; path: string; icon: 'power' | 'lock' | 'key' | 'shield' }[] = [
  { icon: 'power', text: 'Failover tested by powering a server off while requests keep coming', link: 'The test', path: '/docs/operations/ha' },
  { icon: 'lock', text: 'Encrypted nightly backups, with a restore test that checks them', link: 'Backups', path: '/docs/operations/backups' },
  { icon: 'key', text: 'Two-factor sign-in, roles per project and an audit log of changes', link: 'Sign-in', path: '/docs/guides/mfa' },
  { icon: 'shield', text: 'A firewall and automatic security updates on every server', link: 'Hardening', path: '/docs/guides/host-hardening' },
];

/** Smaller features, not shown in a clip. */
export const INCLUDED: { icon: string; title: string; copy: string; link: string; path: string }[] = [
  { icon: 'db', title: 'A database per project', copy: 'PostgreSQL, MongoDB and Redis for each environment, each with its own user.', link: 'Databases', path: '/docs/guides/databases' },
  { icon: 'bell', title: 'Alerts and on-call', copy: 'Alerts to email, Slack, Discord, PagerDuty or a webhook, with escalation and rotations.', link: 'Alerts', path: '/docs/operations/alerting' },
  { icon: 'status', title: 'Public status pages', copy: 'One page per project, fed by your uptime checks, with incidents and maintenance notices.', link: 'Status pages', path: '/docs/guides/status-pages' },
  { icon: 'bug', title: 'Errors and real users', copy: 'Errors grouped into issues by release; session replay and heatmaps with the browser SDKs.', link: 'Error tracking', path: '/docs/observability/error-tracking' },
  { icon: 'branch', title: 'Preview environments', copy: 'Each branch other than main gets a temporary deployment and address.', link: 'Previews', path: '/docs/guides/preview-environments' },
  { icon: 'build', title: 'Builds from source', copy: 'Turn on builds and Cairn builds your image from a Dockerfile or with Buildpacks.', link: 'Builds', path: '/docs/guides/builds' },
];

/** The open-source tools Cairn installs, grouped by what they do for you. */
export const TOOL_GROUPS: { label: string; tools: string }[] = [
  { label: 'Runs on Kubernetes', tools: 'k3s, Argo CD, ingress-nginx, cert-manager' },
  { label: 'Databases', tools: 'PostgreSQL, MongoDB, Redis' },
  { label: 'Storage', tools: 'MinIO, Longhorn' },
  { label: 'Monitoring', tools: 'Prometheus, Grafana, Loki, Tempo, Pyroscope' },
];

/**
 * Cairn next to other ways to run apps. Competitor cells come from their
 * public docs (November 2026). "—" means we could not confirm it: never
 * guess a cell; leave it as "—" instead.
 */
export const COMPARISON = {
  columns: ['Cairn', 'Coolify', 'CapRover', 'Dokku', 'Heroku, Render'],
  rows: [
    { label: 'Runs on your own servers', cells: ['Yes', 'Yes', 'Yes', 'Yes', 'No'] },
    { label: 'Several servers, with database failover', cells: ['Yes', 'Partial', 'Partial', '—', 'Paid plans'] },
    { label: 'Metrics, logs and traces built in', cells: ['Yes', 'Partial', 'Partial', 'Logs', 'Partial'] },
    { label: 'Encrypted off-site backups, with a restore test', cells: ['Yes', 'Partial', '—', 'Via plugins', '—'] },
    { label: 'AI assistant access, with a person approving risky actions', cells: ['Yes', '—', '—', '—', '—'] },
    { label: 'Free to use', cells: ['Personal use', 'Yes', 'Yes', 'Yes', 'Render, limited'] },
  ],
};
