import { normalizeGitUrl, gitUrlsMatch } from '../../src/lib/git-url';
import { assignedNamespace, assignedEnvHost, projectSlug } from '../../src/lib/project-namespace';

describe('git-url normalize', () => {
  it('matches https and git@ forms', () => {
    expect(
      gitUrlsMatch(
        'https://github.com/Mpratyush54/SERVER-automation.git',
        'git@github.com:Mpratyush54/SERVER-automation',
      ),
    ).toBe(true);
  });

  it('rejects different repos', () => {
    expect(
      gitUrlsMatch(
        'https://github.com/Mpratyush54/SERVER-automation',
        'https://github.com/Mpratyush54/other',
      ),
    ).toBe(false);
  });

  it('normalizes trailing slash and case', () => {
    expect(normalizeGitUrl('https://GitHub.com/Org/Repo/')).toBe('github.com/org/repo');
  });
});

describe('project-namespace', () => {
  it('assigns deterministic namespace from project + env', () => {
    expect(assignedNamespace('sdk-demo-apps', 'development')).toBe('sdk-demo-apps-development');
    expect(projectSlug('My Cool App!')).toBe('my-cool-app');
  });

  it('builds host from domain', () => {
    expect(assignedEnvHost('demo', 'staging', '148.113.59.3.sslip.io')).toBe(
      'demo-staging.148.113.59.3.sslip.io',
    );
  });
});
