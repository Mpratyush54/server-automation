import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PrivacyComponent, TermsComponent } from './legal-pages.component';
import { PRIVACY } from './privacy.content';
import { TERMS } from './terms.content';

describe('Legal pages', () => {
  for (const doc of [TERMS, PRIVACY]) {
    it(`${doc.title} has unique section ids and a valid date`, () => {
      const ids = doc.sections.map(s => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every(id => /^[a-z][a-z-]*$/.test(id))).toBeTrue();
      expect(/^\d{4}-\d{2}-\d{2}$/.test(doc.updated)).toBeTrue();
      expect(doc.sections.every(s => s.blocks.length > 0)).toBeTrue();
    });
  }

  it('names the operator and the governing law', () => {
    const text = JSON.stringify(TERMS);
    expect(text).toContain('Neural Nexus');
    expect(text).toContain('laws of India');
  });

  it('describes every kind of data the site and installations send', () => {
    const text = JSON.stringify(PRIVACY);
    for (const fact of ['platform.theme', '__Host-cairn_session', 'PLATFORM_DIAGNOSTICS=off', '180 days', 'Google Fonts', 'Cloudflare', 'privacy@cairnpaas.dev', 'Data Protection Board of India']) {
      expect(text).withContext(fact).toContain(fact);
    }
  });

  for (const [name, cmp, path] of [['Terms', TermsComponent, '/terms'], ['Privacy', PrivacyComponent, '/privacy']] as const) {
    it(`renders the ${name} page with a table of contents and contact links`, async () => {
      await TestBed.configureTestingModule({ imports: [cmp], providers: [provideRouter([])] }).compileComponents();
      const fixture = TestBed.createComponent(cmp as any);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('h1')?.textContent).toContain(name === 'Terms' ? 'Terms of Service' : 'Privacy Policy');
      const toc = Array.from(el.querySelectorAll('.lg-toc a')).map(a => a.getAttribute('href'));
      expect(toc.length).toBeGreaterThan(5);
      expect(toc.every(h => h?.startsWith(path + '#'))).toBeTrue();
      expect(el.querySelector('a[href="mailto:privacy@cairnpaas.dev"]')).not.toBeNull();
      expect(el.querySelector('.lg-switch a.on')?.getAttribute('href')).toBe(path);
    });
  }
});
