export const PERMISSIONS = {
  // Users
  'users.list': 'List all users',
  'users.create': 'Create new users',
  'users.update': 'Update user details',
  'users.delete': 'Delete users',
  'users.assign-role': 'Assign roles to users',
  'users.read-profile': 'View any user profile',

  // Projects
  'projects.list': 'List all projects',
  'projects.create': 'Create projects',
  'projects.update': 'Update project settings',
  'projects.delete': 'Delete projects',
  'projects.read': 'View project details',

  // Deployments
  'deployments.trigger': 'Trigger deployments',
  'deployments.terminate': 'Terminate deployments',
  'deployments.restart': 'Restart deployments',
  'deployments.scale': 'Scale deployments',
  'deployments.read': 'View deployment details',
  'deployments.rollback': 'Rollback deployments',

  // Databases
  'databases.provision': 'Provision new databases',
  'databases.backup': 'Trigger database backups',
  'databases.restore': 'Restore database backups',
  'databases.delete': 'Delete databases',
  'databases.create-connection': 'Create database connections',
  'databases.delete-connection': 'Delete database connections',
  'databases.read': 'View database details',

  // Config
  'config.read': 'View project configuration',
  'config.update': 'Update project configuration',
  'config.delete': 'Delete project configuration',
  'config.manage-feature-flags': 'Manage feature flags',

  // Alerts
  'alerts.list': 'List alerts',
  'alerts.create': 'Create alerts',
  'alerts.update': 'Update alerts',
  'alerts.delete': 'Delete alerts',

  // Logs & Metrics
  'logs.read': 'View application logs',
  'logs.search': 'Search logs',
  'metrics.read': 'View API metrics',
  'metrics.read-rpm': 'View RPM metrics',

  // Settings
  'settings.smtp.read': 'View SMTP settings',
  'settings.smtp.manage': 'Manage SMTP settings',
  'settings.storage.read': 'View storage providers',
  'settings.storage.manage': 'Manage storage providers',

  // Infrastructure / Cluster
  'cluster.read': 'View cluster status',
  'cluster.manage': 'Manage cluster resources',
  'cluster.pods.read': 'View pods',
  'cluster.pods.delete': 'Delete pods',

  // CI/CD
  'cicd.register-webhook': 'Register webhooks',
  'cicd.read': 'View CI/CD pipelines',

  // Bootstrap
  'bootstrap.init': 'Initialize platform',
  'bootstrap.read': 'View bootstrap status',

  // Audit
  'audit.read': 'View audit logs',

  // SDK
  'sdk.send-logs': 'Send SDK logs',
  'sdk.send-metrics': 'Send SDK metrics',
  'sdk.send-bug-reports': 'Submit bug reports',

  // Auth
  'auth.login': 'Login',
  'auth.manage-tokens': 'Manage API tokens',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ROLE_PRESETS: Record<string, Permission[]> = {
  admin: Object.keys(PERMISSIONS) as Permission[],
  devops: [
    'users.list', 'users.create', 'users.update', 'users.read-profile',
    'projects.list', 'projects.create', 'projects.update', 'projects.delete', 'projects.read',
    'deployments.trigger', 'deployments.terminate', 'deployments.restart', 'deployments.scale', 'deployments.read', 'deployments.rollback',
    'databases.provision', 'databases.backup', 'databases.restore', 'databases.delete', 'databases.create-connection', 'databases.delete-connection', 'databases.read',
    'config.read', 'config.update', 'config.delete', 'config.manage-feature-flags',
    'alerts.list', 'alerts.create', 'alerts.update', 'alerts.delete',
    'logs.read', 'logs.search', 'metrics.read', 'metrics.read-rpm',
    'settings.smtp.read', 'settings.smtp.manage', 'settings.storage.read', 'settings.storage.manage',
    'cluster.read', 'cluster.manage', 'cluster.pods.read', 'cluster.pods.delete',
    'cicd.register-webhook', 'cicd.read',
    'bootstrap.init', 'bootstrap.read',
    'audit.read',
    'sdk.send-logs', 'sdk.send-metrics', 'sdk.send-bug-reports',
    'auth.login', 'auth.manage-tokens',
  ],
  tech_lead: [
    'users.list', 'users.read-profile',
    'projects.list', 'projects.create', 'projects.update', 'projects.read',
    'deployments.trigger', 'deployments.terminate', 'deployments.read', 'deployments.rollback',
    'databases.read',
    'config.read', 'config.update', 'config.manage-feature-flags',
    'alerts.list', 'alerts.create', 'alerts.update',
    'logs.read', 'logs.search', 'metrics.read', 'metrics.read-rpm',
    'cicd.read',
    'audit.read',
    'auth.login',
  ],
  developer: [
    'users.read-profile',
    'projects.list', 'projects.read',
    'deployments.trigger', 'deployments.read',
    'databases.read',
    'config.read',
    'alerts.list',
    'logs.read', 'metrics.read',
    'auth.login',
  ],
  viewer: [
    'projects.list', 'projects.read',
    'deployments.read',
    'logs.read',
    'metrics.read',
    'auth.login',
  ],
};
