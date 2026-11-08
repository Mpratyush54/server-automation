// Run on the disposable Ubuntu/k3s VM after building the API and installing RBAC.
// Uses only generated test namespaces; never deletes an existing project namespace.
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { ensureProjectNamespace } from '../dist/lib/namespace-baseline.js';

const suffix = Date.now().toString(36);
const namespaces = [`baseline-e2e-a-${suffix}`, `baseline-e2e-b-${suffix}`];
const created = [];
const kubectl = (args, input) => execFileSync('kubectl', args, { input, encoding: 'utf8', timeout: 180000 });
const apply = body => kubectl(['apply', '-f', '-'], JSON.stringify(body));
const image = process.env.NAMESPACE_TEST_IMAGE || 'python:3.12-alpine';
const pod = namespace => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'probe', namespace, labels: { app: 'baseline-probe' } }, spec: {
  automountServiceAccountToken: false,
  securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: 'RuntimeDefault' } },
  containers: [{ name: 'probe', image, command: ['python', '-m', 'http.server', '8080', '--directory', '/tmp'],
    ports: [{ containerPort: 8080 }], readinessProbe: { httpGet: { path: '/', port: 8080 }, initialDelaySeconds: 1 },
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } } }],
} });
function runPython(namespace, source) {
  return kubectl(['exec', '-i', '-n', namespace, 'probe', '--', 'python', '-'], source);
}
try {
  for (const [i, namespace] of namespaces.entries()) {
    // Refuse to adopt a pre-existing namespace, even on an unlikely timestamp collision.
    const existing = spawnSync('kubectl', ['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'], { encoding: 'utf8' });
    assert.equal(existing.status, 0, existing.stderr);
    assert.equal(existing.stdout.trim(), '', 'Test namespace already exists');
    // Track before creation so a partially applied baseline is cleaned up too.
    created.push(namespace);
    await ensureProjectNamespace(`baseline-test-${i}-${suffix}`, { name: 'preview', namespace });
    apply(pod(namespace));
    apply({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace }, spec: { selector: { app: 'baseline-probe' }, ports: [{ port: 8080, targetPort: 8080 }] } });
    kubectl(['wait', '-n', namespace, '--for=condition=Ready', 'pod/probe', '--timeout=150s']);
    const admitted = JSON.parse(kubectl(['get', 'pod', 'probe', '-n', namespace, '-o', 'json']));
    assert.equal(admitted.spec.containers[0].resources.requests.cpu, '100m');
    assert.equal(admitted.spec.containers[0].resources.limits.memory, '512Mi');
    const privileged = pod(namespace);
    privileged.metadata.name = 'privileged-rejected';
    // A valid spec (privileged implies privilege escalation), so the rejection
    // must come from PodSecurity admission, not field validation.
    privileged.spec.containers[0].securityContext = { privileged: true };
    const rejected = spawnSync('kubectl', ['create', '--dry-run=server', '-f', '-'], { input: JSON.stringify(privileged), encoding: 'utf8' });
    assert.notEqual(rejected.status, 0, 'Privileged pod was admitted');
    assert.match(rejected.stderr, /PodSecurity|violates.*restricted/i);
    const service = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'forbidden-lb', namespace }, spec: { type: 'LoadBalancer', ports: [{ port: 80, targetPort: 8080 }] } };
    const quotaRejected = spawnSync('kubectl', ['create', '--dry-run=server', '-f', '-'], { input: JSON.stringify(service), encoding: 'utf8' });
    assert.notEqual(quotaRejected.status, 0, 'LoadBalancer Service was admitted');
    assert.match(quotaRejected.stderr, /quota/i);
  }
  for (const [i, namespace] of namespaces.entries()) {
    const other = namespaces[1 - i];
    const peer = JSON.parse(kubectl(['get', 'pod', 'probe', '-n', other, '-o', 'json']));
    const peerService = JSON.parse(kubectl(['get', 'service', 'web', '-n', other, '-o', 'json']));
    runPython(namespace, `import socket, urllib.request
assert socket.gethostbyname('kubernetes.default.svc.cluster.local')
assert urllib.request.urlopen('http://web.${namespace}.svc.cluster.local:8080', timeout=5).status == 200
for host in ['${peer.status.podIP}', '${peerService.spec.clusterIP}', 'web.${other}.svc.cluster.local']:
    try:
        socket.create_connection((host, 8080), timeout=3)
    # Blocked either way: dropped (timeout) or rejected (k3s kube-router sends a
    # reset). The peer is Ready via its 8080 readiness probe, so it is listening.
    except (socket.timeout, TimeoutError, ConnectionRefusedError):
        continue
    raise AssertionError('Cross-project connection was allowed: ' + host)
`);
    // Baseline reconciliation must preserve admitted pods and their identities.
    const before = JSON.parse(kubectl(['get', 'pod', 'probe', '-n', namespace, '-o', 'json']));
    await ensureProjectNamespace(`baseline-test-${i}-${suffix}`, { name: 'preview', namespace });
    const after = JSON.parse(kubectl(['get', 'pod', 'probe', '-n', namespace, '-o', 'json']));
    assert.equal(after.metadata.uid, before.metadata.uid);
    assert.equal(after.status.containerStatuses[0].restartCount, before.status.containerStatuses[0].restartCount);
  }
  console.log('PASS: bidirectional pod/Service isolation, DNS/local service, PSA rejection, quota/defaults and idempotent reconciliation');
} finally {
  for (const namespace of created) {
    assert.match(namespace, /^baseline-e2e-[ab]-[a-z0-9]+$/);
    kubectl(['delete', 'namespace', namespace, '--wait=false', '--ignore-not-found']);
  }
}
