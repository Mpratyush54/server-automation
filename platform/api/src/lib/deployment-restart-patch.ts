/** JSON Patch ops for kubectl-style rollout restart. k3s expects an array, not a merge-patch object. */
export function deploymentRestartJsonPatch(restartedAt: string): Array<{ op: 'add'; path: string; value: string }> {
  return [
    {
      op: 'add',
      path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt',
      value: restartedAt,
    },
  ];
}

export function deploymentRestartAnnotationsPatch(restartedAt: string): Array<{
  op: 'add';
  path: string;
  value: Record<string, string>;
}> {
  return [
    {
      op: 'add',
      path: '/spec/template/metadata/annotations',
      value: { 'kubectl.kubernetes.io/restartedAt': restartedAt },
    },
  ];
}
