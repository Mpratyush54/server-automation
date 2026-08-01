/**
 * Normalize Git remote URLs for equality checks.
 * Treats https://github.com/Org/Repo.git === git@github.com:Org/Repo
 */
export function normalizeGitUrl(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input).trim();
  if (!s) return '';

  // git@host:path → https://host/path
  const scp = /^git@([^:]+):(.+)$/i.exec(s);
  if (scp) {
    s = `https://${scp[1]}/${scp[2]}`;
  }

  // ssh://git@host/path
  s = s.replace(/^ssh:\/\/git@/i, 'https://');
  s = s.replace(/^git:\/\//i, 'https://');

  try {
    const u = new URL(s);
    let host = u.hostname.toLowerCase();
    if (host === 'www.github.com') host = 'github.com';
    if (host === 'www.gitlab.com') host = 'gitlab.com';
    let path = u.pathname.replace(/\/+/g, '/').replace(/\.git$/i, '').replace(/\/$/, '');
    path = path.toLowerCase();
    return `${host}${path}`;
  } catch {
    return s
      .toLowerCase()
      .replace(/\.git$/i, '')
      .replace(/\/$/, '')
      .replace(/^https?:\/\//, '');
  }
}

export function gitUrlsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeGitUrl(a);
  const nb = normalizeGitUrl(b);
  if (!na || !nb) return false;
  return na === nb;
}
