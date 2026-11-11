import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { internalUrlTree } from './internal-link';

describe('internalUrlTree', () => {
  let router: Router;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    router = TestBed.inject(Router);
  });

  it('accepts internal paths with query strings', () => {
    const tree = internalUrlTree(router, '/projects/p1/synthetics?check=c1');
    expect(tree).not.toBeNull();
    expect(router.serializeUrl(tree!)).toBe('/projects/p1/synthetics?check=c1');
  });

  it('rejects external, protocol-relative and script URLs', () => {
    for (const bad of ['https://evil.test/x', '//evil.test/x', '/\\evil.test', 'javascript:alert(1)',
      ' javascript:alert(1)', 'data:text/html,hi', '/x\tjavascript:', '/a b', 'projects/p1', '', null, undefined, 42]) {
      expect(internalUrlTree(router, bad)).withContext(String(bad)).toBeNull();
    }
  });
});
