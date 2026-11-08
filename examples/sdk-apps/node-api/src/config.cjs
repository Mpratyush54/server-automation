// Shared by the runnable demo and repository E2E scripts. No network access here.
function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required; see examples/sdk-apps/README.md`);
  return value;
}

function readConfig(env = process.env) {
  // Keep the old E2E variable as an alias for existing automation.
  const platformUrl = required({ ...env, PLATFORM_URL: env.PLATFORM_URL || env.PLATFORM_API_URL }, 'PLATFORM_URL').replace(/\/+$/, '');
  let url;
  try { url = new URL(platformUrl); }
  catch { throw new Error('PLATFORM_URL must be a valid URL, e.g. https://platform.example.com'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PLATFORM_URL must be an HTTP(S) origin, e.g. https://platform.example.com (without /api)');
  }
  const projectDomain = required(env, 'PROJECT_DOMAIN');
  if (projectDomain.length > 253 || !projectDomain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error('PROJECT_DOMAIN must be a hostname without a scheme or path, e.g. example.com');
  }
  return { platformUrl, projectDomain };
}

function readE2EConfig(env = process.env) {
  return { ...readConfig(env), adminEmail: required(env, 'ADMIN_EMAIL'), adminPassword: required(env, 'ADMIN_PASSWORD') };
}

module.exports = { readConfig, readE2EConfig };
