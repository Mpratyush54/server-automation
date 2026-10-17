import {
  highlightSearchText,
  prepareSearchEntries,
  searchDocs,
} from './docs-search';

describe('documentation search ranking', () => {
  const entries = prepareSearchEntries([
    {
      title: 'Installation',
      heading: 'Local development',
      section: 'getting started',
      url: '/docs/getting-started/installation#local-development',
      text: 'Install Docker and start the local databases.',
    },
    {
      title: 'Secrets Management',
      heading: 'Key rotation',
      section: 'guides',
      url: '/docs/guides/secrets-management#key-rotation',
      text: 'Use SECRETS_ENCRYPTION_KEY for encrypted values. Roll back secrets to an earlier version.',
    },
    {
      title: 'Database auth errors after rotating passwords',
      heading: 'Symptom',
      section: 'troubleshooting',
      url: '/docs/troubleshooting/db-wrongpass-after-rotate#symptom',
      text: 'WRONGPASS invalid username-password pair. Rotate database passwords and recover credentials.',
    },
    {
      title: 'Kubernetes Infrastructure',
      heading: 'Networking',
      section: 'architecture',
      url: '/docs/architecture/k8s-infrastructure#networking',
      text: 'Services expose the Kubernetes application.',
    },
    {
      title: 'PostgreSQL',
      heading: 'Constructor',
      section: 'sdk node',
      url: '/docs/api-reference/sdk-node/db-postgres#constructor',
      text: 'Connect to a PostgreSQL database.',
    },
    {
      title: 'Overview',
      heading: 'Tools',
      section: 'mcp',
      url: '/docs/mcp/overview#tools',
      text: 'Kubernetes, PostgreSQL, and scoped MCP tokens.',
    },
  ]);
  it('finds configuration and errors inside page content', () => {
    expect(searchDocs(entries, 'SECRETS_ENCRYPTION_KEY')[0].url).toContain(
      'secrets-management#key-rotation',
    );
    expect(searchDocs(entries, 'WRONGPASS')[0].url).toContain(
      'db-wrongpass-after-rotate',
    );
  });
  it('ranks a multiword question and supports tool aliases', () => {
    expect(
      searchDocs(entries, 'how do I rotate database passwords')[0].url,
    ).toContain('db-wrongpass-after-rotate');
    expect(searchDocs(entries, 'k8s networking')[0].url).toContain(
      'k8s-infrastructure#networking',
    );
    expect(searchDocs(entries, 'pg constructor')[0].url).toContain(
      'db-postgres#constructor',
    );
  });
  it('handles spelling mistakes and ranks title matches above incidental body matches', () => {
    expect(searchDocs(entries, 'kuberenetes')[0].title).toBe(
      'Kubernetes Infrastructure',
    );
    expect(searchDocs(entries, 'postgress')[0].title).toBe('PostgreSQL');
    expect(searchDocs(entries, 'postgress')[0].fuzzy).toBeTrue();
  });
  it('returns no unrelated results and preserves literal snippet text safely', () => {
    expect(searchDocs(entries, 'unfindablexyz')).toEqual([]);
    expect(searchDocs(entries, 'the how do I')).toEqual([]);
    expect(
      highlightSearchText('<script>secrets</script>', 'secrets')
        .map((part) => part.text)
        .join(''),
    ).toBe('<script>secrets</script>');
    expect(
      highlightSearchText('Manage secrets', 'secret').some(
        (part) => part.match,
      ),
    ).toBeTrue();
  });
});
