import {
  classifyAddress, embeddedIpv4, pinnedLookup, resolveTarget, Resolver, SsrfError, validateUrlSyntax,
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
