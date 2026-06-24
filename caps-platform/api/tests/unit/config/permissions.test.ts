import { PERMISSIONS, ROLE_PRESETS } from '../../../src/config/permissions';

describe('Permissions', () => {
  describe('PERMISSIONS constant', () => {
    it('should define all resource permissions', () => {
      expect(PERMISSIONS['users.create']).toBeDefined();
      expect(PERMISSIONS['users.list']).toBeDefined();
      expect(PERMISSIONS['projects.create']).toBeDefined();
      expect(PERMISSIONS['deployments.trigger']).toBeDefined();
      expect(PERMISSIONS['databases.provision']).toBeDefined();
      expect(PERMISSIONS['config.read']).toBeDefined();
      expect(PERMISSIONS['settings.smtp.manage']).toBeDefined();
      expect(PERMISSIONS['cluster.manage']).toBeDefined();
      expect(PERMISSIONS['sdk.send-logs']).toBeDefined();
    });

    it('should have string descriptions for all permissions', () => {
      const entries = Object.entries(PERMISSIONS);
      expect(entries.length).toBeGreaterThan(0);
      for (const [key, desc] of entries) {
        expect(typeof desc).toBe('string');
        expect(desc.length).toBeGreaterThan(0);
      }
    });
  });

  describe('ROLE_PRESETS', () => {
    it('should define admin with all permissions', () => {
      expect(ROLE_PRESETS.admin.length).toBe(Object.keys(PERMISSIONS).length);
    });

    it('should define devops role', () => {
      expect(ROLE_PRESETS.devops).toContain('users.create');
      expect(ROLE_PRESETS.devops).toContain('projects.delete');
      expect(ROLE_PRESETS.devops).toContain('databases.provision');
      expect(ROLE_PRESETS.devops).toContain('settings.smtp.manage');
      expect(ROLE_PRESETS.devops).toContain('cluster.manage');
    });

    it('should define tech_lead role', () => {
      expect(ROLE_PRESETS.tech_lead).toContain('projects.create');
      expect(ROLE_PRESETS.tech_lead).toContain('deployments.trigger');
      expect(ROLE_PRESETS.tech_lead).toContain('config.update');
      expect(ROLE_PRESETS.tech_lead).not.toContain('users.create');
      expect(ROLE_PRESETS.tech_lead).not.toContain('databases.provision');
    });

    it('should define developer role', () => {
      expect(ROLE_PRESETS.developer).toContain('projects.read');
      expect(ROLE_PRESETS.developer).toContain('deployments.trigger');
      expect(ROLE_PRESETS.developer).not.toContain('projects.create');
      expect(ROLE_PRESETS.developer).not.toContain('users.list');
    });

    it('should define viewer role with minimal permissions', () => {
      expect(ROLE_PRESETS.viewer).toContain('projects.read');
      expect(ROLE_PRESETS.viewer).toContain('auth.login');
      expect(ROLE_PRESETS.viewer).not.toContain('deployments.trigger');
      expect(ROLE_PRESETS.viewer).not.toContain('projects.create');
    });

    it('should have ascending permission counts from viewer to admin', () => {
      expect(ROLE_PRESETS.viewer.length).toBeLessThan(ROLE_PRESETS.developer.length);
      expect(ROLE_PRESETS.developer.length).toBeLessThan(ROLE_PRESETS.tech_lead.length);
      expect(ROLE_PRESETS.tech_lead.length).toBeLessThan(ROLE_PRESETS.devops.length);
      expect(ROLE_PRESETS.devops.length).toBeLessThanOrEqual(ROLE_PRESETS.admin.length);
    });
  });
});
