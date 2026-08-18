import { getDb } from '../config/database';
import { IntegrationSettings } from '../entities/IntegrationSettings';

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
  infisicalUrl: string;
  infisicalToken: string;
  githubLoginEnabled: boolean;
  gitlabLoginEnabled: boolean;
};

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
  const githubClientId = pick(row?.githubClientId, process.env.GITHUB_CLIENT_ID);
  const githubClientSecret = pick(row?.githubClientSecret, process.env.GITHUB_CLIENT_SECRET);
  const gitlabClientId = pick(row?.gitlabClientId, process.env.GITLAB_CLIENT_ID);
  const gitlabClientSecret = pick(row?.gitlabClientSecret, process.env.GITLAB_CLIENT_SECRET);
  return {
    row,
    githubClientId,
    githubClientSecret,
    githubToken: pick(row?.githubToken, process.env.GITHUB_TOKEN),
    githubOrg: pick(row?.githubOrg, process.env.GITHUB_ORG),
    gitlabUrl: (pick(row?.gitlabUrl, process.env.GITLAB_URL) || 'https://gitlab.com').replace(/\/+$/, ''),
    gitlabClientId,
    gitlabClientSecret,
    gitlabToken: pick(row?.gitlabToken, process.env.GITLAB_TOKEN),
    gitlabGroup: pick(row?.gitlabGroup, process.env.GITLAB_GROUP),
    clickupToken: pick(row?.clickupToken, process.env.CLICKUP_API_TOKEN),
    clickupListId: pick(row?.clickupListId, process.env.CLICKUP_LIST_ID),
    infisicalUrl: pick(row?.infisicalUrl, process.env.INFISICAL_URL),
    infisicalToken: pick(row?.infisicalToken, process.env.INFISICAL_TOKEN),
    githubLoginEnabled: row?.githubLoginEnabled !== false && Boolean(githubClientId && githubClientSecret),
    gitlabLoginEnabled: row?.gitlabLoginEnabled !== false && Boolean(gitlabClientId && gitlabClientSecret),
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
  if (cfg.infisicalUrl) process.env.INFISICAL_URL = cfg.infisicalUrl;
  if (cfg.infisicalToken) process.env.INFISICAL_TOKEN = cfg.infisicalToken;
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
