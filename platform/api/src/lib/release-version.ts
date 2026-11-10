/** One canonical release value for markers, runtime env and SDK resources. */
export function releaseVersion(dep: { commitSha?: string; imageTag?: string; version?: string }): string {
  const value = dep.commitSha && dep.commitSha !== 'unknown' ? dep.commitSha : dep.imageTag || dep.version;
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,199}$/.test(value)) throw new Error('Release must be a SHA or image tag without whitespace, comma or equals');
  return value;
}
export function releaseEnv(version: string, existing: Array<{ name: string; value?: string; valueFrom?: unknown }> = []) {
  releaseVersion({ imageTag: version });
  const attributes = existing.find(e => e.name === 'OTEL_RESOURCE_ATTRIBUTES');
  if (attributes?.valueFrom) throw new Error('OTEL_RESOURCE_ATTRIBUTES must be literal to merge release metadata');
  const rest = (attributes?.value || '').split(',').filter(v => v && !v.trim().startsWith('service.version='));
  return [
    { name: 'PLATFORM_RELEASE', value: version },
    { name: 'OTEL_SERVICE_VERSION', value: version },
    { name: 'OTEL_RESOURCE_ATTRIBUTES', value: [...rest, `service.version=${version}`].join(',') },
  ];
}
