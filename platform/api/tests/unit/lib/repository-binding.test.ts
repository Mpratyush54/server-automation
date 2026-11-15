import { repositoryApproved, repositoryKey, setProjectRepository, isRepositoryConflict } from '../../../src/lib/repository-binding';

describe('repository keys', () => {
  it.each([
    ['https://github.com/Acme/App.git', 'github.com/acme/app'],
    ['https://github.com/acme/app/', 'github.com/acme/app'],
    ['https://github.com/acme/app.git/', 'github.com/acme/app'],
    ['git@github.com:ACME/app.git', 'github.com/acme/app'],
    ['https://GitLab.com/Group/Sub/App', 'gitlab.com/group/sub/app'],
  ])('normalises %s', (url, key) => { expect(repositoryKey(url)).toBe(key); });

  it('has no key without a repository', () => {
    expect(repositoryKey(null)).toBeNull(); expect(repositoryKey('  ')).toBeNull();
  });
});

describe('repository approval', () => {
  const approved = () => ({ repositoryUrl: 'https://github.com/acme/app.git' as string | null, repositoryKey: 'github.com/acme/app' as string | null,
    repositoryApprovedBy: 'admin' as string | null, repositoryApprovedAt: new Date() as Date | null, repositoryApprovedKey: 'github.com/acme/app' as string | null });

  it('applies only to the repository it was given for', () => {
    expect(repositoryApproved(approved())).toBe(true);
    expect(repositoryApproved({ ...approved(), repositoryUrl: 'https://github.com/acme/other.git' })).toBe(false);
    expect(repositoryApproved({ ...approved(), repositoryApprovedAt: null })).toBe(false);
    expect(repositoryApproved({ repositoryUrl: 'https://github.com/acme/app.git' })).toBe(false);
  });

  it('is kept when the same repository is saved in another spelling', () => {
    const project = approved();
    expect(setProjectRepository(project, 'https://github.com/ACME/app/').changed).toBe(false);
    expect(repositoryApproved(project)).toBe(true);
  });

  it('is cleared whenever the repository changes', () => {
    const project = approved();
    expect(setProjectRepository(project, 'https://github.com/acme/other').changed).toBe(true);
    expect(project).toMatchObject({ repositoryKey: 'github.com/acme/other', repositoryApprovedBy: null, repositoryApprovedAt: null, repositoryApprovedKey: null });
    const cleared = approved();
    setProjectRepository(cleared, null);
    expect(cleared).toMatchObject({ repositoryUrl: null, repositoryKey: null, repositoryApprovedKey: null });
  });

  it('recognises the unique repository index violation', () => {
    expect(isRepositoryConflict({ code: '23505', constraint: 'projects_repository_key_active' })).toBe(true);
    expect(isRepositoryConflict({ code: '23505', constraint: 'projects_name_key' })).toBe(false);
  });
});
