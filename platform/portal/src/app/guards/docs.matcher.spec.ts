import { DefaultUrlSerializer, PRIMARY_OUTLET, Route, UrlSegmentGroup } from '@angular/router';
import { docsMatcher } from './docs.matcher';

describe('docsMatcher', () => {
  function match(path: string) {
    const tree = new DefaultUrlSerializer().parse(path);
    const group = tree.root.children[PRIMARY_OUTLET] || new UrlSegmentGroup([], {});
    return docsMatcher(group.segments, group, {} as Route);
  }

  it('keeps the full nested section from a pasted API-reference URL', () => {
    const result = match('/docs/api-reference/configuration/environment-variables');
    expect(result?.consumed.length).toBe(4);
    expect(result?.posParams?.['section'].path).toBe('api-reference/configuration');
    expect(result?.posParams?.['page'].path).toBe('environment-variables');
  });

  it('supports the docs home, categories, and ordinary pages', () => {
    expect(match('/docs')?.posParams).toEqual({});
    expect(match('/docs/getting-started')?.posParams?.['section'].path).toBe('getting-started');
    expect(match('/docs/mcp/overview')?.posParams?.['page'].path).toBe('overview');
    expect(match('/docs/mcp/overview/')?.posParams?.['section'].path).toBe('mcp');
    expect(match('/docs/mcp/overview/')?.posParams?.['page'].path).toBe('overview');
  });

  it('leaves app routes to their existing guards', () => {
    expect(match('/dashboard')).toBeNull();
    expect(match('/api/projects')).toBeNull();
  });
});
