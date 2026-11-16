// Settings for a recording run come only from the environment (or an env file
// passed with --env-file). Nothing about a real install is written in the repo.
import { fileURLToPath } from 'node:url';

const DOCS = 'See videos/recordings/README.md, "Settings".';

export function env(name, { required = false, fallback } = {}) {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (required) throw new Error(`Set ${name} before recording. ${DOCS}`);
  return fallback;
}

/** Base URL of the Cairn portal, without a trailing slash. */
export function cairnUrl() {
  const url = env('CAIRN_URL', { required: true }).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new Error('CAIRN_URL must start with https:// (or http:// for a local test)');
  return url;
}

export const VIEWPORT = { width: 1280, height: 800 };
export const SCALE = 2;

export function outDir() {
  return env('RECORDINGS_OUT', { fallback: fileURLToPath(new URL('../out/', import.meta.url)) });
}

/** Human typing pace: ms per character, with a little jitter so it does not look robotic. */
export function typingDelay() {
  return Number(env('TYPING_MS', { fallback: '70' }));
}
