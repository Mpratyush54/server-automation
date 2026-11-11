import dns from 'dns';
import net from 'net';

/**
 * SSRF guard for synthetic checks (#42).
 *
 * Checks run against user-supplied URLs from inside the cluster, so every target is
 * resolved first, EVERY resolved address is classified, and the connection is then made
 * to that exact address (the HTTP/TLS clients get a pinned `lookup`). A second DNS answer
 * (DNS rebinding) can therefore never redirect the connection to an internal address.
 *
 * Refused: loopback, link-local (cloud metadata), unspecified, multicast/broadcast,
 * reserved/documentation ranges, RFC 1918 / CGNAT / IPv6 ULA (cluster pod and service
 * networks), IPv4-mapped / NAT64 forms of those, cluster-internal names (`*.svc`,
 * `*.cluster.local`, `localhost`, single-label names), URLs with credentials and
 * non-HTTP(S) schemes.
 *
 * Exception: a host that is one of the project's own ingress hosts may resolve to a
 * private address (single-server installs on a LAN), but only on ports 80/443 and never
 * to loopback / link-local / unspecified / multicast addresses.
 *
 * Platform hosts (#152): the platform's own DOMAIN and every name under it are public
 * endpoints served by the ingress controller (in-cluster CoreDNS rewrites them to the
 * ingress Service). They are never resolved on their own: the connection always goes to
 * the ingress controller Service address (ports 80/443 only), so no other cluster or
 * private address becomes reachable through them.
 */

export type AddressClass = 'public' | 'private' | 'forbidden';

const FORBIDDEN = new net.BlockList();
const PRIVATE = new net.BlockList();

// Always refused, even for the project's own ingress host.
for (const [a, p] of [
  ['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
] as [string, number][]) FORBIDDEN.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['2001::', 23],
] as [string, number][]) FORBIDDEN.addSubnet(a, p, 'ipv6');

// Private networks: refused unless the target is the project's own ingress host.
for (const [a, p] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]] as [string, number][]) {
  PRIVATE.addSubnet(a, p, 'ipv4');
}
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

/** IPv4 embedded in an IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible or NAT64 (64:ff9b::/96) IPv6 address. */
export function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function classifyAddress(ip: string): AddressClass {
  const family = net.isIP(ip);
  if (family === 0) return 'forbidden';
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return classifyAddress(v4);
    // Any other address in ::/96 or ::ffff:0:0/96 (odd encodings) is refused outright.
    if (/^::(ffff:)?[0-9a-f.:]*$/i.test(ip) && ip !== '::') return 'forbidden';
    if (FORBIDDEN.check(ip, 'ipv6')) return 'forbidden';
    if (PRIVATE.check(ip, 'ipv6')) return 'private';
    return 'public';
  }
  if (ip === '255.255.255.255') return 'forbidden';
  if (FORBIDDEN.check(ip, 'ipv4')) return 'forbidden';
  if (PRIVATE.check(ip, 'ipv4')) return 'private';
  return 'public';
}

/** Ingress controller Service; the CoreDNS rewrite sends DOMAIN and *.DOMAIN there. */
export const INGRESS_SERVICE = 'ingress-nginx-controller.ingress-nginx.svc.cluster.local';

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.svc', '.cluster.local', '.localdomain', '.home.arpa', '.lan'];

export class SsrfError extends Error {
  readonly status = 400;
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface ResolvedTarget {
  url: URL;
  hostname: string;
  port: number;
  /** The validated address the connection must use. */
  address: string;
  family: 4 | 6;
  /** True when allowed only because the host is one of the project's ingress hosts or a platform host. */
  ingressException: boolean;
  /** True when the host is the platform's DOMAIN or under it (connected via the ingress Service). */
  platformHost: boolean;
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const systemResolver: Resolver = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true }) as Promise<Array<{ address: string; family: number }>>;

export interface GuardOptions {
  /** Lower-cased ingress hosts owned by the check's project. */
  allowedIngressHosts?: string[];
  resolver?: Resolver;
  /**
   * The platform's own domain (DOMAIN and *.DOMAIN are reached via the ingress Service).
   * Defaults to process.env.DOMAIN; null disables platform hosts.
   */
  platformDomain?: string | null;
  /** Addresses of the ingress controller Service (default: cluster DNS for INGRESS_SERVICE). */
  ingressResolver?: () => Promise<string[]>;
  /** Platform CA certificate (PEM), trusted in addition to the public roots for platform hosts. */
  platformCa?: string | null;
}

function normaliseHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The platform domain as a bare lower-case host name, or null. A value that is not a
 * multi-label host name, or that is itself a cluster-internal name, is ignored.
 */
export function platformDomainOf(raw: string | null | undefined = process.env.DOMAIN): string | null {
  const d = normaliseHost(String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/[/:].*$/, ''));
  if (!d || !HOST_RE.test(d) || net.isIP(d) !== 0) return null;
  if (d === 'cluster.local' || d.endsWith('.svc') || d.endsWith('.cluster.local') || d.endsWith('.localhost')) return null;
  return d;
}

/** Whether a (normalised) host is the platform domain or one of its subdomains. */
export function isPlatformHost(host: string, domain: string | null): boolean {
  if (!domain || net.isIP(host) !== 0) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

const resolvePlatformDomain = (v: string | null | undefined) => (v === null ? null : platformDomainOf(v === undefined ? process.env.DOMAIN : v));

export const systemIngressResolver = async (): Promise<string[]> =>
  (await systemResolver(INGRESS_SERVICE)).map((a) => a.address);

/** Static URL checks (no DNS): scheme, credentials, internal names, literal addresses. */
export function validateUrlSyntax(raw: string, opts: { allowedIngressHosts?: string[]; schemes?: string[]; platformDomain?: string | null } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Target must be an absolute http(s) URL', 'invalid_url');
  }
  const schemes = opts.schemes || ['http:', 'https:'];
  if (!schemes.includes(url.protocol)) throw new SsrfError(`Scheme ${url.protocol} is not allowed`, 'scheme');
  if (url.username || url.password) throw new SsrfError('Credentials in the URL are not allowed; use a secret header', 'credentials');
  const host = normaliseHost(url.hostname);
  if (!host) throw new SsrfError('Target host is required', 'invalid_url');
  const allowed = (opts.allowedIngressHosts || []).includes(host) || isPlatformHost(host, resolvePlatformDomain(opts.platformDomain));
  if (!allowed) {
    if (host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
      throw new SsrfError('Cluster-internal and local host names are not allowed', 'internal_host');
    }
    if (net.isIP(host) === 0 && !host.includes('.')) {
      throw new SsrfError('Single-label host names are not allowed', 'internal_host');
    }
  }
  if (net.isIP(host) !== 0) {
    const cls = classifyAddress(host);
    if (cls !== 'public') throw new SsrfError('Private, loopback and link-local addresses are not allowed', 'private_address');
  }
  return url;
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'http:' ? 80 : 443;
}

/**
 * Validate a URL and resolve it to ONE address that is safe to connect to.
 * All DNS answers must pass (a mix of public and private answers is refused).
 */
export async function resolveTarget(raw: string, opts: GuardOptions = {}, schemes?: string[]): Promise<ResolvedTarget> {
  const allowedHosts = (opts.allowedIngressHosts || []).map(normaliseHost);
  const platformDomain = resolvePlatformDomain(opts.platformDomain);
  const url = validateUrlSyntax(raw, { allowedIngressHosts: allowedHosts, schemes, platformDomain });
  const hostname = normaliseHost(url.hostname);
  const port = portOf(url);
  const isOwnIngress = allowedHosts.includes(hostname);

  if (isPlatformHost(hostname, platformDomain)) {
    // Never resolved on its own: always the ingress controller Service, nothing else.
    if (port !== 80 && port !== 443) throw new SsrfError('Platform hosts are only reachable on ports 80 and 443', 'port');
    let ingress: string[];
    try {
      ingress = await (opts.ingressResolver || systemIngressResolver)();
    } catch (err: any) {
      throw new SsrfError(`The ingress controller address for ${hostname} could not be resolved (${err?.code || 'error'})`, 'dns');
    }
    const usable = (ingress || []).filter((a) => net.isIP(a) !== 0 && classifyAddress(a) !== 'forbidden');
    if (usable.length === 0) throw new SsrfError(`No usable ingress controller address for ${hostname}`, 'dns');
    const address = usable.find((a) => net.isIP(a) === 4) || usable[0];
    return { url, hostname, port, address, family: net.isIP(address) === 6 ? 6 : 4, ingressException: true, platformHost: true };
  }

  let answers: Array<{ address: string; family: number }>;
  if (net.isIP(hostname) !== 0) {
    answers = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      answers = await (opts.resolver || systemResolver)(hostname);
    } catch (err: any) {
      throw new SsrfError(`DNS lookup failed for ${hostname} (${err?.code || 'error'})`, 'dns');
    }
  }
  if (!answers || answers.length === 0) throw new SsrfError(`No addresses for ${hostname}`, 'dns');

  let usesPrivate = false;
  for (const a of answers) {
    const cls = classifyAddress(a.address);
    if (cls === 'forbidden') throw new SsrfError(`${hostname} resolves to a forbidden address`, 'private_address');
    if (cls === 'private') {
      if (!isOwnIngress) throw new SsrfError(`${hostname} resolves to a private address`, 'private_address');
      usesPrivate = true;
    }
  }
  if (usesPrivate && port !== 80 && port !== 443) {
    throw new SsrfError('Private ingress targets are only allowed on ports 80 and 443', 'port');
  }
  const chosen = answers.find((a) => a.family === 4) || answers[0];
  return {
    url,
    hostname,
    port,
    address: chosen.address,
    family: (net.isIP(chosen.address) === 6 ? 6 : 4),
    ingressException: usesPrivate,
    platformHost: false,
  };
}

/** A `lookup` for http/https/tls that always answers with the pre-validated address. */
export function pinnedLookup(target: Pick<ResolvedTarget, 'address' | 'family'>) {
  return (_host: string, options: any, cb?: any) => {
    const callback = typeof options === 'function' ? options : cb;
    const all = typeof options === 'object' && options?.all;
    if (all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}
