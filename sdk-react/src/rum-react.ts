import { useEffect } from 'react';
import { normalizeRouteName, setRumView } from './rum';

/** Anything with a `pathname`, e.g. react-router's `useLocation()` (v6 and v7) or `window.location`. */
export interface RumLocationLike {
  pathname: string;
}

/**
 * Record a RUM view per route change. With react-router v6/v7:
 *
 *   function RumRoutes() { useRumPageView(useLocation()); return null; }
 *
 * The view name defaults to the normalized path (`/users/42` -> `/users/:id`);
 * pass `name` (e.g. the matched route pattern) to override. No-op when RUM is off.
 */
export function useRumPageView(location: RumLocationLike, name?: string): void {
  const pathname = location?.pathname || '/';
  useEffect(() => {
    setRumView(name || normalizeRouteName(pathname));
  }, [pathname, name]);
}
