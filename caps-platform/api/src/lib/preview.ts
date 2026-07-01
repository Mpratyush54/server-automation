export function generatePreviewUrl(branch: string, suffix?: string): string {
  const sanitized = branch
    .replace(/^(feature|fix|chore)\//i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
  const previewSuffix = suffix || process.env.DOMAIN || 'sslip.io';
  return `${sanitized}.preview.${previewSuffix}`;
}



export function validateBranchName(branch: string): { valid: boolean; error?: string } {
  if (!branch.match(/^(feature|fix)\/CU-\d+-[a-zA-Z0-9_-]+$/)) {
    return { valid: false, error: 'Branch must follow pattern: feature/CU-{id}-{description} or fix/CU-{id}-{description}' };
  }
  return { valid: true };
}
