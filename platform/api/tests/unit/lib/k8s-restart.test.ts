import {
  deploymentRestartAnnotationsPatch,
  deploymentRestartJsonPatch,
} from '../../../src/lib/deployment-restart-patch';

describe('deploymentRestartJsonPatch', () => {
  it('emits a JSON Patch array (k3s rejects merge-patch objects)', () => {
    const at = '2026-08-18T17:56:50.000Z';
    const patch = deploymentRestartJsonPatch(at);
    expect(Array.isArray(patch)).toBe(true);
    expect(patch).toEqual([
      {
        op: 'add',
        path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt',
        value: at,
      },
    ]);
  });

  it('JSON-pointer-escapes the slash in kubectl.kubernetes.io/restartedAt', () => {
    const path = deploymentRestartJsonPatch('t')[0].path;
    expect(path).toContain('~1');
    expect(path).not.toMatch(/kubectl\.kubernetes\.io\/restartedAt/);
  });

  it('falls back to adding the annotations object when the map is missing', () => {
    const at = '2026-08-18T17:56:50.000Z';
    expect(deploymentRestartAnnotationsPatch(at)).toEqual([
      {
        op: 'add',
        path: '/spec/template/metadata/annotations',
        value: { 'kubectl.kubernetes.io/restartedAt': at },
      },
    ]);
  });
});
