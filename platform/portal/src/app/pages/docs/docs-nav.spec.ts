import { DOC_GROUPS } from './docs-nav';

describe('build documentation navigation', () => {
  it('makes the source build guide available under Guides', () => {
    const guides = DOC_GROUPS.find(group => group.id === 'guides');
    expect(guides?.pages).toContain(jasmine.objectContaining({ label: 'Build from Git', section: 'guides', page: 'builds' }));
  });
});
