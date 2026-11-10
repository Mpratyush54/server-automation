import { normalizeSessionId, normalizeSubjectId } from '../../../src/lib/privacy-consent';

describe('normalizeSubjectId / normalizeSessionId', () => {
  it('accepts stable ids and rejects empty/illegal', () => {
    expect(normalizeSubjectId('user-42')).toBe('user-42');
    expect(normalizeSubjectId('alice@example.com')).toBe('alice@example.com');
    expect(normalizeSubjectId('')).toBeNull();
    expect(normalizeSubjectId('has space')).toBeNull();
    expect(normalizeSessionId('sess.1')).toBe('sess.1');
    expect(normalizeSessionId('')).toBe('');
  });
});
