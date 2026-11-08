import { createHash } from 'crypto';
export function generatePreviewUrl(branch: string, projectSlug?: string, suffix?: string, projectId?: string): string {
  const sanitized = branch
    .replace(/^(feature|fix|chore)\//i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
  if (projectId) return `preview-${createHash('sha256').update(projectId).digest('hex').slice(0, 16)}-${createHash('sha256').update(branch).digest('hex').slice(0, 16)}.preview.${suffix || process.env.DOMAIN || 'sslip.io'}`;
  const previewSuffix = suffix || process.env.DOMAIN || 'sslip.io';
  if (projectSlug) {
    return `${projectSlug}-${sanitized}.preview.${previewSuffix}`;
  }
  return `${sanitized}.preview.${previewSuffix}`;
}



export function validateBranchName(branch: string): { valid: boolean; error?: string } {
  if (!branch.match(/^(feature|fix)\/CU-\d+-[a-zA-Z0-9_-]+$/)) {
    return { valid: false, error: 'Branch must follow pattern: feature/CU-{id}-{description} or fix/CU-{id}-{description}' };
  }
  return { valid: true };
}
