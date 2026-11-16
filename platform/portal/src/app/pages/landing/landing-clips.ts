import { CLIP_VERSIONS } from './landing-clip-versions';

/**
 * Where the feature clips are served from: a Cloudflare R2 bucket behind its
 * own domain, never the app server. Change it here only. Each clip lives at
 * `<MEDIA_BASE>/<id>.mp4` (plus .webm, -poster.jpg and .en.vtt). The clips
 * are recorded from a real install by videos/recordings/.
 */
export const MEDIA_BASE = 'https://media.cairnpaas.dev/v1';

/** One product feature on the landing page and the clip that shows it. */
export interface FeatureClip {
  /** File name on the media host and the section anchor. */
  id: string;
  /** Short label used in the feature index. */
  label: string;
  /** Heading: the claim, then a quieter second line. */
  title: string;
  subtitle: string;
  /** One or two plain sentences. */
  copy: string;
  guide: { label: string; path: string };
  /** What the recording shows, step by step. Shown until the clip is published. */
  shows: string[];
}

export const FEATURE_CLIPS: FeatureClip[] = [
  {
    id: 'install',
    label: 'Install',
    title: 'One command sets up a server.',
    subtitle: 'Kubernetes and everything on top.',
    copy: 'Run platformctl provision on an Ubuntu server. It checks your backup bucket first, then installs Kubernetes, the portal, databases and monitoring, and prints where to sign in.',
    guide: { label: 'Installation guide', path: '/docs/getting-started/installation' },
    shows: [
      'sudo platformctl provision on a fresh Ubuntu server',
      'Choosing the domain, the admin email and where backups go',
      'Each component installing and reporting ready',
      'Signing in to the portal at the printed address',
    ],
  },
  {
    id: 'deploy-from-git',
    label: 'Deploy',
    title: 'Push to Git, see it live.',
    subtitle: 'Every deployment tracked.',
    copy: 'Link a repository and pick a branch for each environment. Cairn deploys the Kubernetes files in it and shows each deployment, its commit and its health on the project page.',
    guide: { label: 'Deploy your first app', path: '/docs/getting-started/deploy-your-app' },
    shows: [
      'Creating a project from a Git repository',
      'Choosing the branch for production',
      'The first deployment syncing and turning healthy',
      'Opening the app at its new address',
    ],
  },
  {
    id: 'observability',
    label: 'Observe',
    title: 'Logs, metrics and traces.',
    subtitle: 'For every project, built in.',
    copy: "Open a project's Monitoring section to search its logs, watch request rates and follow one slow request through your services. Traces need the full install profile and the Cairn SDK.",
    guide: { label: 'Search logs, traces and metrics', path: '/docs/guides/observability' },
    shows: [
      'The project overview with request rate and errors',
      'Finding the slowest endpoint and opening one of its traces',
      'Jumping from the trace to the log lines of that request',
    ],
  },
  {
    id: 'backups',
    label: 'Back up',
    title: 'Backups you have restored.',
    subtitle: 'Not just backups you have taken.',
    copy: 'Send encrypted backups to your own S3-compatible bucket, then run a restore test that restores the latest one into a scratch database and checks it. Settings shows when each last ran.',
    guide: { label: 'Back up and restore', path: '/docs/operations/backups' },
    shows: [
      'Pointing backups at an S3-compatible bucket and testing access',
      'Taking an encrypted archive',
      'Running platformctl backup restore-test',
      'The result in the portal, under Settings, Security, Recovery backups',
    ],
  },
  {
    id: 'high-availability',
    label: 'Stay up',
    title: 'Turn a server off.',
    subtitle: 'The others take over.',
    copy: 'Run Cairn on three servers. When one loses power, the others restart its apps and take over its databases, with at most a few seconds of errors, and it rejoins on its own.',
    guide: { label: 'High availability guide', path: '/docs/operations/ha' },
    shows: [
      'Three servers ready on the Infrastructure page, and a request loop against the app',
      'One server powered off',
      'The server marked not ready, and what the requests saw meanwhile',
      'The server back and rejoined',
    ],
  },
  {
    id: 'mcp',
    label: 'AI agents',
    title: 'Let an AI assistant help.',
    subtitle: 'A person approves risky changes.',
    copy: 'Paste one connector URL into Claude, ChatGPT, Cursor or VS Code. The assistant reads health, logs and pods; deleting, scaling or reading secrets waits for a person to approve.',
    guide: { label: 'Connect an AI assistant', path: '/docs/mcp/overview' },
    shows: [
      'Creating an agent token with only the permissions it needs',
      'An assistant using it to list the pods of an app',
      'A scale command held in Waiting for approval',
      'A person approving it in the portal, and the command running',
    ],
  },
];

/** URLs of one published clip. The version follows the file contents, so caches never serve an old cut. */
export interface ClipMedia {
  mp4: string;
  webm: string;
  poster: string;
  captions: string;
}

export interface LandingFeature extends FeatureClip {
  /** Null until the clip is recorded and uploaded. */
  media: ClipMedia | null;
}

export function clipMedia(id: string, version: string | undefined, base = MEDIA_BASE): ClipMedia | null {
  if (!version) return null;
  const url = (suffix: string) => `${base}/${id}${suffix}?v=${version}`;
  return { mp4: url('.mp4'), webm: url('.webm'), poster: url('-poster.jpg'), captions: url('.en.vtt') };
}

export function landingFeatures(versions: Readonly<Record<string, string>> = CLIP_VERSIONS): LandingFeature[] {
  return FEATURE_CLIPS.map((clip) => ({ ...clip, media: clipMedia(clip.id, versions[clip.id]) }));
}
