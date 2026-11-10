/**
 * SSRF guard for outbound alert notifications (#43).
 *
 * Channel URLs are user input. Before any request, and again at connect time (custom DNS
 * lookup on the HTTP agent, so DNS rebinding cannot swap in an internal address after the
 * check), every resolved address is checked: loopback, private (RFC 1918), CGNAT,
 * link-local (incl. cloud metadata), multicast, unspecified, ULA, IPv4-mapped forms of those,
 * and other non-public ranges are refused unless the channel explicitly allows private
 * networks (admin-only flag). Redirects are not followed.
 */
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';

export class SsrfBlockedError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this" network / unspecified
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

function expandV6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const n = v4ToInt(v4[1]);
    addr = addr.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  if (addr.split('::').length > 2) return null;
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = addr.includes('::') ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t];
  if (parts.length !== 8) return null;
  const out = parts.map((p) => parseInt(p || '0', 16));
  return out.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : out;
}

/** True for any address that must not be reached from the API without explicit opt-in. */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return V4_BLOCKED.some(([b, bits]) => inV4Range(ip, b, bits));
  if (family !== 6) return true; // not an IP: refuse
  const p = expandV6(ip);
  if (!p) return true;
  if (p.every((x) => x === 0)) return true; // ::
  if (p.slice(0, 7).every((x) => x === 0) && p[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96): check the v4 part.
  const embedded = (p.slice(0, 5).every((x) => x === 0) && (p[5] === 0xffff || p[5] === 0))
    || (p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((x) => x === 0));
  if (embedded) {
    const v4 = `${p[6] >> 8}.${p[6] & 0xff}.${p[7] >> 8}.${p[7] & 0xff}`;
    return isPrivateAddress(v4);
  }
  if ((p[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((p[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((p[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((p[0] & 0xff00) === 0xff00) return true; // multicast
  if (p[0] === 0x2001 && p[1] === 0x0db8) return true; // documentation
  if (p[0] === 0x2002) return true; // 6to4 can embed private v4
  if (p[0] === 0x2001 && p[1] === 0) return true; // Teredo
  return false;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

export interface UrlPolicy {
  allowPrivate?: boolean;
  /** Require https (chat/paging providers). Generic webhooks may use http. */
  httpsOnly?: boolean;
}

/** Validate a destination URL and every address it resolves to. Returns the parsed URL. */
export async function assertSafeUrl(raw: string, policy: UrlPolicy = {}, resolve: Resolver = defaultResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SsrfBlockedError('Only http(s) URLs are allowed');
  if (policy.httpsOnly && url.protocol !== 'https:') throw new SsrfBlockedError('This channel requires an https URL');
  if (url.username || url.password) throw new SsrfBlockedError('URLs with credentials are not allowed');
  if (policy.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.svc|.*\.cluster\.local)$/i.test(host)) {
    throw new SsrfBlockedError('Destination is an internal host name');
  }
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolve(host).catch(() => {
    throw new SsrfBlockedError('Destination host does not resolve');
  });
  if (!addrs.length) throw new SsrfBlockedError('Destination host does not resolve');
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new SsrfBlockedError('Destination resolves to a private or link-local address');
  }
  return url;
}

/**
 * dns.lookup replacement for http(s) agents: refuses private addresses at connect time
 * (defends against DNS rebinding between the check and the request).
 */
export function guardedLookup(allowPrivate: boolean, lookup: typeof dns.lookup = dns.lookup) {
  return (hostname: string, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options || {};
    lookup(hostname, { ...opts, all: true }, (err: any, addresses: any) => {
      if (err) return cb(err);
      const list: { address: string; family: number }[] = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (!allowPrivate) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) return cb(new SsrfBlockedError('Destination resolves to a private or link-local address'));
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

export function guardedAgents(allowPrivate: boolean) {
  const lookup = guardedLookup(allowPrivate) as any;
  return {
    httpAgent: new http.Agent({ lookup, keepAlive: false }),
    httpsAgent: new https.Agent({ lookup, keepAlive: false }),
  };
}
