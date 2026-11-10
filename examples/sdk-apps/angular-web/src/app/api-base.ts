/** API base from /app-config.js (runtime); '' = same origin (dev proxy / nginx). */
export const API_BASE: string = ((window as any).__APP_CONFIG__?.apiBase as string) || '';
