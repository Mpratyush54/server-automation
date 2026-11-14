import { isPublicMarketingHost, MARKETING_HOSTS } from './public-domain.guard';
import { publicDocsUrl } from './public-domain.guard';

describe('isPublicMarketingHost', () => {
  it('matches the configured marketing host exactly', () => {
    expect(MARKETING_HOSTS).toContain('platform.pratyushes.dev');
    expect(isPublicMarketingHost('platform.pratyushes.dev')).toBeTrue();
    expect(isPublicMarketingHost('PLATFORM.pratyushes.dev.')).toBeTrue();
  });

  it('treats other subdomains of the zone as app hosts', () => {
    expect(isPublicMarketingHost('app.pratyushes.dev')).toBeFalse();
    expect(isPublicMarketingHost('portal.pratyushes.dev')).toBeFalse();
    expect(isPublicMarketingHost('evil.platform.pratyushes.dev')).toBeFalse();
    expect(isPublicMarketingHost('localhost')).toBeFalse();
  });

  it('accepts an explicit host allowlist', () => {
    expect(isPublicMarketingHost('docs.example.com', ['docs.example.com'])).toBeTrue();
    expect(isPublicMarketingHost('platform.pratyushes.dev', ['docs.example.com'])).toBeFalse();
  });
});

describe('publicDocsUrl', () => {
  it('keeps the docs path, query and fragment on the public site', () => {
    expect(publicDocsUrl('/docs/getting-started/installation?x=1#sign-in'))
      .toBe('https://platform.pratyushes.dev/docs/getting-started/installation?x=1#sign-in');
  });
  it('falls back to the docs home for anything else', () => {
    expect(publicDocsUrl('/login')).toBe('https://platform.pratyushes.dev/docs');
  });
});
