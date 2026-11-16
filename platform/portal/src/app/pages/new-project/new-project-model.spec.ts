import {
  buildPlan, domainProblem, emptyDraft, envHostPreview, isDirty, memberProblems, nameProblem, parseRepo,
  repoProblem, revisionProblem, stepProblem, varProblems,
} from './new-project-model';

describe('new project model', () => {
  it('validates the name live', () => {
    expect(nameProblem('', [])).toContain('Enter a name');
    expect(nameProblem('Shop', [])).toContain('lowercase');
    expect(nameProblem('my shop', [])).toContain('letters, numbers and dashes');
    expect(nameProblem('-shop', [])).toContain('Start and end');
    expect(nameProblem('my--shop', [])).toContain('single dashes');
    expect(nameProblem('a'.repeat(41), [])).toContain('at most 40');
    expect(nameProblem('shop', ['blog', 'shop'])).toContain('already exists');
    expect(nameProblem('shop-2', ['shop'])).toBeNull();
  });

  it('accepts GitHub and GitLab repository addresses over HTTPS and SSH', () => {
    expect(parseRepo('https://github.com/acme/shop.git')).toEqual({ provider: 'GitHub', host: 'github.com', ownerRepo: 'acme/shop' });
    expect(parseRepo('git@gitlab.com:acme/group/api.git')?.ownerRepo).toBe('acme/group/api');
    expect(repoProblem('')).toBeNull();
    expect(repoProblem('github.com/acme')).not.toBeNull();
    expect(repoProblem('https://github.com/acme')).not.toBeNull();
    expect(repoProblem('ftp://github.com/acme/shop')).not.toBeNull();
  });

  it('checks branch and domain', () => {
    expect(revisionProblem('')).toBeNull();
    expect(revisionProblem('feature x')).toContain('spaces');
    expect(domainProblem('')).toBeNull();
    expect(domainProblem('https://example.com')).toContain('without https');
    expect(domainProblem('Example.com')).toContain('lowercase');
    expect(domainProblem('203.0.113.7.sslip.io')).toBeNull();
    expect(domainProblem('example')).not.toBeNull();
  });

  it('previews each environment address like the API names it', () => {
    expect(envHostPreview('shop', 'staging', 'example.com')).toBe('shop-staging-<code>.example.com');
    expect(envHostPreview('shop', 'production', '')).toBe('shop-production-<code>.<server domain>');
  });

  it('flags bad and duplicate variables but ignores empty rows', () => {
    const errs = varProblems([
      { key: '', value: '', secret: false, scope: 'all' },
      { key: '1BAD', value: 'x', secret: false, scope: 'all' },
      { key: 'API_URL', value: 'x', secret: false, scope: 'all' },
      { key: 'API_URL', value: 'y', secret: false, scope: 'all' },
      { key: 'API_URL', value: 'z', secret: false, scope: 'staging' },
      { key: 'TOKEN', value: '', secret: true, scope: 'all' },
    ]);
    expect(errs[0]).toBeNull();
    expect(errs[1]).toContain('start with a letter');
    expect(errs[2]).toBeNull();
    expect(errs[3]).toContain('already set');
    expect(errs[4]).toBeNull();
    expect(errs[5]).toContain('secret value');
  });

  it('flags bad members', () => {
    const errs = memberProblems([
      { userId: '', email: 'nope', role: 'viewer' },
      { userId: 'u1', email: '', role: 'viewer' },
      { userId: 'u1', email: '', role: 'owner' },
      { userId: 'me', email: '', role: 'owner' },
    ], 'me');
    expect(errs[0]).toContain('valid email');
    expect(errs[1]).toBeNull();
    expect(errs[2]).toContain('already');
    expect(errs[3]).toContain('automatically');
  });

  it('gives a plain reason per step', () => {
    const d = emptyDraft();
    expect(stepProblem('app', d, [])).toContain('Enter a name');
    d.name = 'shop';
    expect(stepProblem('app', d, [])).toBeNull();
    d.repositoryUrl = 'nope';
    expect(stepProblem('code', d, [])).toContain('repository address');
    expect(stepProblem('data', d, [])).toBeNull();
  });

  it('knows when there is input to lose', () => {
    const d = emptyDraft();
    expect(isDirty(d)).toBeFalse();
    d.variables.push({ key: '', value: '', secret: false, scope: 'all' });
    expect(isDirty(d)).toBeFalse();
    d.databases.staging = true;
    expect(isDirty(d)).toBeTrue();
  });

  it('plans the API calls in order, project first', () => {
    const d = emptyDraft();
    d.name = 'shop';
    d.databases.production = true;
    d.variables = [{ key: ' API_URL ', value: 'x', secret: false, scope: 'all' }, { key: '', value: '', secret: false, scope: 'all' }];
    d.privacy.replay = true;
    d.members = [{ userId: 'u1', email: '', role: 'developer' }];
    const plan = buildPlan(d, () => 'Ben');
    expect(plan.map((p) => p.kind)).toEqual(['project', 'database', 'variable', 'consent', 'member']);
    expect(plan[2].variable?.key).toBe('API_URL');
    expect(plan[4].label).toContain('Ben');
  });
});
