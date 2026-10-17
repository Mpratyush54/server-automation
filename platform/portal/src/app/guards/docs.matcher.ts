import { UrlMatcher, UrlSegment } from '@angular/router';

/** Keep nested documentation sections intact, including api-reference/configuration. */
export const docsMatcher: UrlMatcher = segments => {
  if (segments[0]?.path !== 'docs') return null;
  const path = segments.slice(1).filter(segment => segment.path);
  const posParams: Record<string, UrlSegment> = {};
  if (path.length === 1) posParams['section'] = path[0];
  if (path.length > 1) {
    posParams['section'] = new UrlSegment(path.slice(0, -1).map(segment => segment.path).join('/'), {});
    posParams['page'] = path[path.length - 1];
  }
  return { consumed: segments, posParams };
};
