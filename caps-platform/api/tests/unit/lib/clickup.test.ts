import { extractTaskId, sanitizeBranch, formatPreviewComment } from '../../../src/lib/clickup';

describe('ClickUp Library', () => {
  describe('extractTaskId', () => {
    it('should extract CU task ID from branch name', () => {
      expect(extractTaskId('feature/CU-123-add-login')).toBe('CU-123');
    });

    it('should extract CU task ID case-insensitively', () => {
      expect(extractTaskId('feature/cu-456-fix-bug')).toBe('CU-456');
    });

    it('should return null when no CU task ID found', () => {
      expect(extractTaskId('feature/my-feature')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(extractTaskId('')).toBeNull();
    });
  });

  describe('sanitizeBranch', () => {
    it('should remove feature/ prefix', () => {
      expect(sanitizeBranch('feature/my-feature')).toBe('my-feature');
    });

    it('should remove fix/ prefix', () => {
      expect(sanitizeBranch('fix/my-fix')).toBe('my-fix');
    });

    it('should remove chore/ prefix', () => {
      expect(sanitizeBranch('chore/update-deps')).toBe('update-deps');
    });

    it('should lowercase the branch name', () => {
      expect(sanitizeBranch('feature/MyFeature')).toBe('myfeature');
    });

    it('should collapse consecutive hyphens', () => {
      expect(sanitizeBranch('feature/a---b')).toBe('a-b');
    });

    it('should remove leading and trailing hyphens', () => {
      expect(sanitizeBranch('feature/-test-')).toBe('test');
    });
  });

  describe('formatPreviewComment', () => {
    it('should format preview comment with all fields', async () => {
      const result = await formatPreviewComment({
        project: 'my-app',
        branch: 'feature/CU-1-add-login',
        url: 'my-app.preview.capskengeri.com',
        commit: 'abc123',
      });

      expect(result).toContain('Preview environment ready');
      expect(result).toContain('Project:     my-app');
      expect(result).toContain('Branch:      feature/CU-1-add-login');
      expect(result).toContain('URL:         my-app.preview.capskengeri.com');
      expect(result).toContain('Commit:      abc123');
    });
  });
});
