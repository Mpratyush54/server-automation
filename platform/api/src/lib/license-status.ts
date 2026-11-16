export type LicenseState = 'valid' | 'attention' | 'invalid' | 'unknown';

export interface LicenseSummary {
  available: boolean;
  status: string | null;
  state: LicenseState;
  plan: string | null;
  org: string | null;
  maxNodes: number | null;
  maxInstalls: number | null;
  expiresAt: string | null;
  graceUntil: string | null;
  lastCheckin: string | null;
  updatedAt: string | null;
  enforce: boolean;
}

const WORD = /^[a-z_]{1,32}$/;

function time(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 64) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000 ? v : null;
}

function text(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

export const EMPTY_LICENSE: LicenseSummary = {
  available: false, status: null, state: 'unknown', plan: null, org: null, maxNodes: null, maxInstalls: null,
  expiresAt: null, graceUntil: null, lastCheckin: null, updatedAt: null, enforce: false,
};

/** platform/platform-license-status ConfigMap `status.json`; whitelisted fields only. */
export function parseLicenseStatus(raw: string | null | undefined): LicenseSummary {
  if (!raw) return { ...EMPTY_LICENSE };
  let v: any;
  try { v = JSON.parse(raw); } catch { return { ...EMPTY_LICENSE }; }
  if (!v || typeof v !== 'object') return { ...EMPTY_LICENSE };
  const code = typeof v.exit_code === 'number' ? v.exit_code : null;
  const state: LicenseState = code === 0 ? 'valid' : code === 10 ? 'attention' : code === null ? 'unknown' : 'invalid';
  const plan = typeof v.plan === 'string' && WORD.test(v.plan) ? v.plan : null;
  return {
    available: true,
    status: typeof v.status === 'string' && WORD.test(v.status) ? v.status : null,
    state,
    plan,
    org: text(v.org),
    maxNodes: count(v.max_nodes),
    maxInstalls: count(v.max_installs),
    expiresAt: time(v.expires_at),
    graceUntil: time(v.grace_until),
    lastCheckin: time(v.last_checkin),
    updatedAt: time(v.updated_at),
    enforce: v.enforce === true,
  };
}
