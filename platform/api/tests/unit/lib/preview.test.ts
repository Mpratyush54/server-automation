import { generatePreviewUrl, validateBranchName } from '../../../src/lib/preview';

describe('Preview Library', () => {
  describe('generatePreviewUrl', () => {
    it('should generate preview URL from feature branch', () => {
      expect(generatePreviewUrl('feature/CU-123-add-login')).toBe('cu-123-add-login.preview.platform.dev');
    });

    it('should generate preview URL from fix branch', () => {
      expect(generatePreviewUrl('fix/CU-456-bugfix')).toBe('cu-456-bugfix.preview.platform.dev');
    });

    it('should remove special characters', () => {
      expect(generatePreviewUrl('feature/my_branch.test')).toBe('my-branch-test.preview.platform.dev');
    });

    it('should lowercase the URL', () => {
      expect(generatePreviewUrl('feature/MyBranch')).toBe('mybranch.preview.platform.dev');
    });

    it('should handle branch without prefix', () => {
      expect(generatePreviewUrl('CU-789-feature')).toBe('cu-789-feature.preview.platform.dev');
    });

    it('should collapse multiple hyphens', () => {
      expect(generatePreviewUrl('feature/a---b')).toBe('a-b.preview.platform.dev');
    });

    it('should trim leading and trailing hyphens', () => {
      expect(generatePreviewUrl('feature/-test-')).toBe('test.preview.platform.dev');
    });
  });

  describe('validateBranchName', () => {
    it('should accept valid feature branch', () => {
      const result = validateBranchName('feature/CU-123-add-login');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid fix branch', () => {
      const result = validateBranchName('fix/CU-456-bugfix');
      expect(result.valid).toBe(true);
    });

    it('should accept branch with underscores', () => {
      const result = validateBranchName('feature/CU-1-my_feature_name');
      expect(result.valid).toBe(true);
    });

    it('should accept branch with hyphens', () => {
      const result = validateBranchName('feature/CU-1-my-feature-name');
      expect(result.valid).toBe(true);
    });

    it('should reject branch without CU task ID', () => {
      const result = validateBranchName('feature/my-feature');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Branch must follow pattern');
    });

    it('should reject branch with wrong prefix', () => {
      const result = validateBranchName('chore/CU-123-task');
      expect(result.valid).toBe(false);
    });

    it('should reject branch without description', () => {
      const result = validateBranchName('feature/CU-123-');
      expect(result.valid).toBe(false);
    });

    it('should reject empty string', () => {
      const result = validateBranchName('');
      expect(result.valid).toBe(false);
    });

    it('should reject branch with spaces', () => {
      const result = validateBranchName('feature/CU-1 my feature');
      expect(result.valid).toBe(false);
    });
  });
});
