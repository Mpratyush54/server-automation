import { Router, UrlTree } from '@angular/router';

/**
 * Turn a server-supplied link into a router UrlTree, but only when it is an
 * internal app path ("/projects/..."). Absolute URLs, protocol-relative
 * ("//host"), backslash tricks and javascript:/data: URLs return null so the
 * caller renders plain text instead of a link.
 */
export function internalUrlTree(router: Router, url: unknown): UrlTree | null {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (!u.startsWith('/') || u.startsWith('//')) return null;
  // Backslashes (browsers treat "/\host" as "//host"), whitespace and control
  // characters can smuggle a host or scheme past naive checks.
  if (/[\u0000- \u007f\\]/.test(u)) return null;
  try {
    return router.parseUrl(u);
  } catch {
    return null;
  }
}
