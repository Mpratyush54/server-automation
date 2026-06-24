import { UserRole } from '../../../src/entities/User';
import { StackType } from '../../../src/entities/Project';
import { DeploymentStatus } from '../../../src/entities/Deployment';

describe('Entities', () => {
  describe('UserRole enum', () => {
    it('should have correct values', () => {
      expect(UserRole.DEVELOPER).toBe('developer');
      expect(UserRole.TECH_LEAD).toBe('tech_lead');
      expect(UserRole.DEVOPS).toBe('devops');
      expect(UserRole.ADMIN).toBe('admin');
      expect(UserRole.VIEWER).toBe('viewer');
    });

    it('should have exactly 5 roles', () => {
      const roles = Object.values(UserRole);
      expect(roles).toHaveLength(5);
    });
  });

  describe('StackType enum', () => {
    it('should have correct values', () => {
      expect(StackType.NODEJS).toBe('nodejs');
      expect(StackType.ANGULAR).toBe('angular');
      expect(StackType.PYTHON).toBe('python');
      expect(StackType.STATIC).toBe('static');
    });

    it('should have exactly 4 stack types', () => {
      const stacks = Object.values(StackType);
      expect(stacks).toHaveLength(4);
    });
  });

  describe('DeploymentStatus enum', () => {
    it('should have correct values', () => {
      expect(DeploymentStatus.PENDING).toBe('pending');
      expect(DeploymentStatus.BUILDING).toBe('building');
      expect(DeploymentStatus.DEPLOYING).toBe('deploying');
      expect(DeploymentStatus.DEPLOYED).toBe('deployed');
      expect(DeploymentStatus.FAILED).toBe('failed');
      expect(DeploymentStatus.ROLLED_BACK).toBe('rolled_back');
      expect(DeploymentStatus.TERMINATED).toBe('terminated');
      expect(DeploymentStatus.EXPIRED).toBe('expired');
    });

    it('should have exactly 8 statuses', () => {
      const statuses = Object.values(DeploymentStatus);
      expect(statuses).toHaveLength(8);
    });
  });

  describe('UserRole hierarchy', () => {
    it('admin should have highest permissions', () => {
      const roleHierarchy: Record<string, number> = {
        viewer: 0,
        developer: 1,
        tech_lead: 2,
        devops: 3,
        admin: 4,
      };
      expect(roleHierarchy[UserRole.ADMIN]).toBeGreaterThan(roleHierarchy[UserRole.DEVOPS]);
      expect(roleHierarchy[UserRole.DEVOPS]).toBeGreaterThan(roleHierarchy[UserRole.TECH_LEAD]);
      expect(roleHierarchy[UserRole.TECH_LEAD]).toBeGreaterThan(roleHierarchy[UserRole.DEVELOPER]);
      expect(roleHierarchy[UserRole.DEVELOPER]).toBeGreaterThan(roleHierarchy[UserRole.VIEWER]);
    });
  });
});
