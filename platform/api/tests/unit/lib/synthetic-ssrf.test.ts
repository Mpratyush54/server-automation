import {
  classifyAddress, embeddedIpv4, isPlatformHost, pinnedLookup, platformDomainOf, resolveTarget, Resolver, SsrfError, validateUrlSyntax,
} from '../../../src/lib/synthetic-ssrf';

const fixed = (...addrs: string[]): Resolver => async () => addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('address classification', () => {
  it.each([
    ['127.0.0.1', 'forbidden'], ['0.0.0.0', 'forbidden'], ['169.254.169.254', 'forbidden'], ['224.0.0.1', 'forbidden'],
    ['255.255.255.255', 'forbidden'], ['192.0.2.10', 'forbidden'], ['::1', 'forbidden'], ['::', 'forbidden'],
    ['fe80::1', 'forbidden'], ['ff02::1', 'forbidden'], ['::ffff:127.0.0.1', 'forbidden'], ['::ffff:7f00:1', 'forbidden'],
    ['::ffff:169.254.169.254', 'forbidden'], ['64:ff9b::a9fe:a9fe', 'forbidden'],
    ['10.43.0.1', 'private'], ['10.42.3.7', 'private'], ['172.16.5.4', 'private'], ['192.168.1.10', 'private'],
    ['100.64.0.1', 'private'], ['fd00::1', 'private'], ['::ffff:10.0.0.1', 'private'],
    ['93.184.216.34', 'public'], ['8.8.8.8', 'public'], ['2606:4700::1111', 'public'], ['172.32.0.1', 'public'],
    ['not-an-ip', 'forbidden'],
  ])('%s is %s', (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  it('extracts embedded IPv4', () => {
    expect(embeddedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIpv4('64:ff9b::10.0.0.1')).toBe('10.0.0.1');
    expect(embeddedIpv4('2606:4700::1')).toBeNull();
  });
});

describe('URL syntax', () => {
  it.each([
    ['ftp://example.com/', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['https://user:pw@example.com/', 'credentials'],
    ['http://localhost:3000/', 'internal_host'],
    ['http://platform-api.platform.svc:3000/', 'internal_host'],
    ['http://kubernetes.default.svc.cluster.local/', 'internal_host'],
    ['http://metadata/', 'internal_host'],
    ['http://printer.local/', 'internal_host'],
    ['http://169.254.169.254/latest/meta-data/', 'private_address'],
    ['http://[::1]/', 'private_address'],
    ['http://10.43.0.1/', 'private_address'],
    ['not a url', 'invalid_url'],
  ])('refuses %s (%s)', (url, code) => {
    try {
      validateUrlSyntax(url);
      throw new Error('expected refusal');
    } catch (err: any) {
      expect(err).toBeInstanceOf(SsrfError);
      expect(err.code).toBe(code);
    }
  });

  it('accepts public URLs', () => {
    expect(validateUrlSyntax('https://example.com/health?x=1').hostname).toBe('example.com');
  });
});

describe('resolveTarget', () => {
  it('refuses a name that resolves to a private, loopback or metadata address', async () => {
    for (const addr of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', '::ffff:10.1.2.3']) {
      await expect(resolveTarget('https://evil.example/', { resolver: fixed(addr) })).rejects.toMatchObject({ code: 'private_address' });
    }
  });

  it('refuses when ANY answer is internal (mixed public + private)', async () => {
    await expect(resolveTarget('https://mixed.example/', { resolver: fixed('93.184.216.34', '10.0.0.1') })).rejects.toBeInstanceOf(SsrfError);
  });

  it('returns the validated address and prefers IPv4', async () => {
    const t = await resolveTarget('https://ok.example:8443/x', { resolver: fixed('2606:4700::1', '93.184.216.34') });
    expect(t).toMatchObject({ hostname: 'ok.example', port: 8443, address: '93.184.216.34', family: 4, ingressException: false });
  });

  it('DNS rebinding: resolves once, then the connection is pinned to the validated address', async () => {
    let calls = 0;
    // First answer public, every later answer internal (the rebinding attack).
    const rebinding: Resolver = async () => {
      calls += 1;
      return [{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    };
    const t = await resolveTarget('http://rebind.example/', { resolver: rebinding });
    expect(calls).toBe(1);
    const lookup = pinnedLookup(t);
    const seen: any[] = [];
    lookup('rebind.example', {}, (err: any, address: string, family: number) => seen.push([err, address, family]));
    lookup('rebind.example', { all: true }, (err: any, all: any) => seen.push([err, all]));
    lookup('rebind.example', (err: any, address: string) => seen.push([err, address]));
    expect(seen).toEqual([
      [null, '93.184.216.34', 4],
      [null, [{ address: '93.184.216.34', family: 4 }]],
      [null, '93.184.216.34'],
    ]);
    expect(calls).toBe(1); // the pinned lookup never queries DNS again
    // A later re-validation sees the new answer and refuses it.
    await expect(resolveTarget('http://rebind.example/', { resolver: rebinding })).rejects.toMatchObject({ code: 'private_address' });
  });

  it('own ingress host may be private, on 80/443 only, never loopback/link-local', async () => {
    const opts = (addr: string) => ({ resolver: fixed(addr), allowedIngressHosts: ['app.customer.example'] });
    const t = await resolveTarget('https://app.customer.example/', opts('192.168.1.20'));
    expect(t).toMatchObject({ address: '192.168.1.20', ingressException: true });
    await expect(resolveTarget('https://app.customer.example:10250/', opts('192.168.1.20'))).rejects.toMatchObject({ code: 'port' });
    await expect(resolveTarget('https://app.customer.example/', opts('127.0.0.1'))).rejects.toMatchObject({ code: 'private_address' });
    await expect(resolveTarget('https://app.customer.example/', opts('169.254.169.254'))).rejects.toMatchObject({ code: 'private_address' });
    // Another project's host gets no exception.
    await expect(resolveTarget('https://other.customer.example/', opts('192.168.1.20'))).rejects.toMatchObject({ code: 'private_address' });
  });

  it('reports DNS failures', async () => {
    const failing: Resolver = async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); };
    await expect(resolveTarget('https://nx.example/', { resolver: failing })).rejects.toMatchObject({ code: 'dns' });
  });
});

describe('platform hosts (DOMAIN and *.DOMAIN) via the ingress controller (#152)', () => {
  const INGRESS = '10.43.12.7';
  const resolverCalls: string[] = [];
  const dnsAnswer = (addr: string): Resolver => async (h) => { resolverCalls.push(h); return [{ address: addr, family: 4 }]; };
  const opts = (extra: Record<string, any> = {}) => ({
    platformDomain: 'apps.example.com',
    ingressResolver: async () => [INGRESS],
    resolver: dnsAnswer('10.99.99.99'),
    ...extra,
  });
  beforeEach(() => { resolverCalls.length = 0; });

  it('DOMAIN and api.DOMAIN connect to the ingress Service address, never their own DNS answer', async () => {
    for (const url of ['https://apps.example.com/', 'https://api.apps.example.com/api/health', 'http://grafana.apps.example.com/login', 'https://API.Apps.Example.com./x']) {
      const t = await resolveTarget(url, opts());
      expect(t).toMatchObject({ address: INGRESS, family: 4, ingressException: true, platformHost: true });
    }
    expect(resolverCalls).toEqual([]); // the host name itself is never resolved
    const lookupSeen: any[] = [];
    pinnedLookup(await resolveTarget('https://api.apps.example.com/', opts()))('api.apps.example.com', {}, (...a: any[]) => lookupSeen.push(a));
    expect(lookupSeen).toEqual([[null, INGRESS, 4]]);
  });

  it('defaults the platform domain to process.env.DOMAIN; null disables it', async () => {
    const prev = process.env.DOMAIN;
    process.env.DOMAIN = 'Apps.Example.COM';
    try {
      const t = await resolveTarget('https://api.apps.example.com/', { ingressResolver: async () => [INGRESS], resolver: dnsAnswer('10.99.99.99') });
      expect(t.address).toBe(INGRESS);
      await expect(resolveTarget('https://api.apps.example.com/', { platformDomain: null, resolver: dnsAnswer('10.43.12.7') }))
        .rejects.toMatchObject({ code: 'private_address' });
    } finally {
      if (prev === undefined) delete process.env.DOMAIN; else process.env.DOMAIN = prev;
    }
  });

  it('only on ports 80/443', async () => {
    await expect(resolveTarget('https://api.apps.example.com:10250/', opts())).rejects.toMatchObject({ code: 'port' });
    await expect(resolveTarget('http://apps.example.com:8080/', opts())).rejects.toMatchObject({ code: 'port' });
    await expect(resolveTarget('http://apps.example.com:80/', opts())).resolves.toMatchObject({ address: INGRESS });
  });

  it('fails closed when the ingress address is unknown or unusable', async () => {
    await expect(resolveTarget('https://apps.example.com/', opts({ ingressResolver: async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); } })))
      .rejects.toMatchObject({ code: 'dns' });
    await expect(resolveTarget('https://apps.example.com/', opts({ ingressResolver: async () => [] }))).rejects.toMatchObject({ code: 'dns' });
    for (const bad of ['127.0.0.1', '169.254.169.254', '::1', 'not-an-ip']) {
      await expect(resolveTarget('https://apps.example.com/', opts({ ingressResolver: async () => [bad] }))).rejects.toMatchObject({ code: 'dns' });
    }
  });

  it('every other private / cluster / metadata target is still refused', async () => {
    for (const url of ['http://10.43.0.1/', 'http://10.42.3.7:8080/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/', 'http://172.16.0.1/',
      'http://[::1]/', 'http://[fd00::1]/']) {
      await expect(resolveTarget(url, opts())).rejects.toMatchObject({ code: 'private_address' });
    }
    for (const url of ['http://platform-api.platform.svc:3000/', 'http://kubernetes.default.svc.cluster.local/', 'http://localhost/', 'http://metadata/']) {
      await expect(resolveTarget(url, opts())).rejects.toMatchObject({ code: 'internal_host' });
    }
    // Names outside the platform domain resolving privately: refused as before.
    for (const url of ['https://evil.example/', 'https://apps.example.com.evil.example/', 'https://evilapps.example.com/']) {
      await expect(resolveTarget(url, opts())).rejects.toMatchObject({ code: 'private_address' });
    }
  });

  it('a redirect from a platform host to a private target is refused (each hop is re-validated)', async () => {
    // syntheticHttpRequest calls resolveTarget for every hop with the same guard.
    const first = await resolveTarget('https://apps.example.com/login', opts());
    expect(first.platformHost).toBe(true);
    for (const location of ['http://10.43.0.10:3000/', 'http://169.254.169.254/', 'http://platform-api.platform.svc:3000/api', 'https://api.apps.example.com:6443/']) {
      const next = new URL(location, first.url).toString();
      await expect(resolveTarget(next, opts())).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it('URL syntax accepts platform hosts even under a LAN-style suffix', () => {
    expect(() => validateUrlSyntax('https://platform.lan/')).toThrow(SsrfError);
    expect(validateUrlSyntax('https://api.platform.lan/', { platformDomain: 'platform.lan' }).hostname).toBe('api.platform.lan');
    expect(() => validateUrlSyntax('http://x.svc/', { platformDomain: 'platform.lan' })).toThrow(SsrfError);
  });

  it('platformDomainOf ignores unusable values; isPlatformHost matches on a label boundary', () => {
    expect(platformDomainOf('https://Apps.Example.com/')).toBe('apps.example.com');
    expect(platformDomainOf('apps.example.com:443')).toBe('apps.example.com');
    for (const v of ['', 'localhost', 'com', 'svc', 'cluster.local', 'default.svc.cluster.local', 'x.svc', '10.0.0.1', 'bad host']) {
      expect(platformDomainOf(v)).toBeNull();
    }
    expect(isPlatformHost('apps.example.com', 'apps.example.com')).toBe(true);
    expect(isPlatformHost('a.b.apps.example.com', 'apps.example.com')).toBe(true);
    expect(isPlatformHost('evilapps.example.com', 'apps.example.com')).toBe(false);
    expect(isPlatformHost('apps.example.com', null)).toBe(false);
  });
});
