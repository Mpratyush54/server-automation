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
});
