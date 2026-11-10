import { getDb } from '../config/database';
import { IntegrationSettings } from '../entities/IntegrationSettings';
import { loadGithubApp } from './github-app';
import { loadGitlabApp } from './gitlab-app';

export type ResolvedIntegrations = {
  row: IntegrationSettings | null;
  githubClientId: string;
  githubClientSecret: string;
  githubToken: string;
  githubOrg: string;
  gitlabUrl: string;
  gitlabClientId: string;
  gitlabClientSecret: string;
  gitlabToken: string;
  gitlabGroup: string;
  clickupToken: string;
  clickupListId: string;
  githubLoginEnabled: boolean;
  gitlabLoginEnabled: boolean;
  /** Where the OAuth client credentials come from (#35): automated app first, then manual entry, then env. */
  githubSource: CredentialSource;
  gitlabSource: CredentialSource;
};

export type CredentialSource = 'app' | 'manual' | 'env' | 'none';

function sourceOf(fromApp: boolean, dbVal: string | null | undefined, envVal: string | undefined): CredentialSource {
  if (fromApp) return 'app';
  if (dbVal && dbVal.trim()) return 'manual';
  if (envVal && envVal.trim()) return 'env';
  return 'none';
}

function pick(dbVal: string | null | undefined, envVal: string | undefined): string {
  return (dbVal && dbVal.trim()) || (envVal || '').trim();
}

export async function getOrCreateIntegrationSettings(): Promise<IntegrationSettings> {
  const ds = await getDb();
  const repo = ds.getRepository(IntegrationSettings);
  let row = (await repo.find({ order: { createdAt: 'ASC' }, take: 1 }))[0];
  if (!row) {
    row = await repo.save(repo.create({
      githubLoginEnabled: true,
      gitlabLoginEnabled: true,
      gitlabUrl: process.env.GITLAB_URL || 'https://gitlab.com',
    }));
  }
  return row;
}

export async function resolveIntegrations(): Promise<ResolvedIntegrations> {
  let row: IntegrationSettings | null = null;
  try {
    row = await getOrCreateIntegrationSettings();
  } catch {
    row = null;
  }
  // Automated connect (#35): a GitHub App / GitLab OAuth app created by the platform wins;
  // manually entered OAuth apps and env values remain the fallback.
  const githubApp = await loadGithubApp().catch(() => null);
  const gitlabApp = await loadGitlabApp().catch(() => null);
  const ghFromApp = Boolean(githubApp?.clientId && githubApp.clientSecret);
  const glFromApp = Boolean(gitlabApp?.clientId && gitlabApp.clientSecret);
  const githubClientId = ghFromApp ? githubApp!.clientId : pick(row?.githubClientId, process.env.GITHUB_CLIENT_ID);
  const githubClientSecret = ghFromApp ? githubApp!.clientSecret : pick(row?.githubClientSecret, process.env.GITHUB_CLIENT_SECRET);
  const gitlabClientId = glFromApp ? gitlabApp!.clientId : pick(row?.gitlabClientId, process.env.GITLAB_CLIENT_ID);
  const gitlabClientSecret = glFromApp ? gitlabApp!.clientSecret : pick(row?.gitlabClientSecret, process.env.GITLAB_CLIENT_SECRET);
  return {
    row,
    githubClientId,
    githubClientSecret,
    githubToken: pick(row?.githubToken, process.env.GITHUB_TOKEN),
    githubOrg: pick(row?.githubOrg, process.env.GITHUB_ORG),
    gitlabUrl: ((glFromApp && gitlabApp!.baseUrl) || pick(row?.gitlabUrl, process.env.GITLAB_URL) || 'https://gitlab.com').replace(/\/+$/, ''),
    gitlabClientId,
    gitlabClientSecret,
    gitlabToken: pick(row?.gitlabToken, process.env.GITLAB_TOKEN),
    gitlabGroup: pick(row?.gitlabGroup, process.env.GITLAB_GROUP),
    clickupToken: pick(row?.clickupToken, process.env.CLICKUP_API_TOKEN),
    clickupListId: pick(row?.clickupListId, process.env.CLICKUP_LIST_ID),
    githubLoginEnabled: row?.githubLoginEnabled !== false && Boolean(githubClientId && githubClientSecret),
    gitlabLoginEnabled: row?.gitlabLoginEnabled !== false && Boolean(gitlabClientId && gitlabClientSecret),
    githubSource: sourceOf(ghFromApp, row?.githubClientId, process.env.GITHUB_CLIENT_ID),
    gitlabSource: sourceOf(glFromApp, row?.gitlabClientId, process.env.GITLAB_CLIENT_ID),
  };
}

/** Apply saved tokens into process.env so webhook/CI code picks them up without restart. */
export function applyIntegrationsToEnv(cfg: ResolvedIntegrations) {
  if (cfg.githubToken) process.env.GITHUB_TOKEN = cfg.githubToken;
  if (cfg.githubOrg) process.env.GITHUB_ORG = cfg.githubOrg;
  if (cfg.gitlabToken) process.env.GITLAB_TOKEN = cfg.gitlabToken;
  if (cfg.gitlabUrl) process.env.GITLAB_URL = cfg.gitlabUrl;
  if (cfg.gitlabGroup) process.env.GITLAB_GROUP = cfg.gitlabGroup;
  if (cfg.clickupToken) process.env.CLICKUP_API_TOKEN = cfg.clickupToken;
  if (cfg.clickupListId) process.env.CLICKUP_LIST_ID = cfg.clickupListId;
  if (cfg.githubClientId) process.env.GITHUB_CLIENT_ID = cfg.githubClientId;
  if (cfg.githubClientSecret) process.env.GITHUB_CLIENT_SECRET = cfg.githubClientSecret;
  if (cfg.gitlabClientId) process.env.GITLAB_CLIENT_ID = cfg.gitlabClientId;
  if (cfg.gitlabClientSecret) process.env.GITLAB_CLIENT_SECRET = cfg.gitlabClientSecret;
}

export async function hydrateIntegrationsEnv(): Promise<void> {
  applyIntegrationsToEnv(await resolveIntegrations());
}

export function publicAuthProviders(cfg: ResolvedIntegrations) {
  return {
    github: {
      enabled: cfg.githubLoginEnabled,
      configured: Boolean(cfg.githubClientId && cfg.githubClientSecret),
    },
    gitlab: {
      enabled: cfg.gitlabLoginEnabled,
      configured: Boolean(cfg.gitlabClientId && cfg.gitlabClientSecret),
      url: cfg.gitlabUrl,
    },
  };
}

export function maskSecret(value: string | null | undefined): { set: boolean; hint: string } {
  const v = (value || '').trim();
  if (!v) return { set: false, hint: '' };
  if (v.length <= 8) return { set: true, hint: '********' };
  return { set: true, hint: `${v.slice(0, 4)}…${v.slice(-4)}` };
}
