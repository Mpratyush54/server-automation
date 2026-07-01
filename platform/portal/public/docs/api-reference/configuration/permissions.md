# Permission Matrix

Complete list of all 48 permissions and their assignment to built-in role presets. Custom roles can contain any combination of these permissions.

> **Legend:** ✓ = Granted | — = Denied

---

## Permission Descriptions

| Permission | Description |
|---|---|
| `auth.login` | Login to the platform |
| `auth.manage-tokens` | Manage API tokens |
| `users.list` | List all users |
| `users.create` | Create new users |
| `users.update` | Update user details |
| `users.delete` | Delete users |
| `users.assign-role` | Assign roles to users |
| `users.read-profile` | View any user profile |
| `projects.list` | List all projects |
| `projects.create` | Create projects |
| `projects.update` | Update project settings |
| `projects.delete` | Delete projects |
| `projects.read` | View project details |
| `deployments.trigger` | Trigger deployments |
| `deployments.terminate` | Terminate deployments |
| `deployments.restart` | Restart deployments |
| `deployments.scale` | Scale deployments |
| `deployments.read` | View deployment details |
| `deployments.rollback` | Rollback deployments |
| `databases.provision` | Provision new databases |
| `databases.backup` | Trigger database backups |
| `databases.restore` | Restore database backups |
| `databases.delete` | Delete databases |
| `databases.create-connection` | Create database connections |
| `databases.delete-connection` | Delete database connections |
| `databases.read` | View database details |
| `config.read` | View project configuration |
| `config.update` | Update project configuration |
| `config.delete` | Delete project configuration |
| `config.manage-feature-flags` | Manage feature flags |
| `secrets.list` | List secrets (values masked) |
| `secrets.read` | View secret details |
| `secrets.reveal` | Reveal secret plaintext values |
| `secrets.create` | Create secrets |
| `secrets.update` | Update secrets |
| `secrets.delete` | Delete secrets |
| `secrets.export` | Export secrets as .env |
| `secrets.import` | Bulk import secrets |
| `secrets.rollback` | Rollback secret to previous version |
| `alerts.list` | List alerts |
| `alerts.create` | Create alerts |
| `alerts.update` | Update alerts |
| `alerts.delete` | Delete alerts |
| `logs.read` | View application logs |
| `logs.search` | Search logs |
| `metrics.read` | View API metrics |
| `metrics.read-rpm` | View RPM metrics |
| `settings.smtp.read` | View SMTP settings |
| `settings.smtp.manage` | Manage SMTP settings |
| `settings.storage.read` | View storage providers |
| `settings.storage.manage` | Manage storage providers |
| `cluster.read` | View cluster status |
| `cluster.manage` | Manage cluster resources |
| `cluster.pods.read` | View pods |
| `cluster.pods.delete` | Delete pods |
| `cicd.register-webhook` | Register webhooks |
| `cicd.read` | View CI/CD pipelines |
| `bootstrap.init` | Initialize platform |
| `bootstrap.read` | View bootstrap status |
| `audit.read` | View audit logs |
| `sdk.send-logs` | Send SDK logs |
| `sdk.send-metrics` | Send SDK metrics |
| `sdk.send-bug-reports` | Submit bug reports |

---

## Matrix

### Auth

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `auth.login` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `auth.manage-tokens` | ✓ | ✓ | | | |

### User Management

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `users.list` | ✓ | ✓ | ✓ | | |
| `users.create` | ✓ | ✓ | | | |
| `users.update` | ✓ | ✓ | | | |
| `users.delete` | ✓ | ✓ | | | |
| `users.assign-role` | ✓ | ✓ | | | |
| `users.read-profile` | ✓ | ✓ | ✓ | ✓ | |

### Projects

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `projects.list` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `projects.create` | ✓ | ✓ | ✓ | | |
| `projects.update` | ✓ | ✓ | ✓ | | |
| `projects.delete` | ✓ | ✓ | | | |
| `projects.read` | ✓ | ✓ | ✓ | ✓ | ✓ |

### Deployments

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `deployments.trigger` | ✓ | ✓ | ✓ | ✓ | |
| `deployments.terminate` | ✓ | ✓ | ✓ | | |
| `deployments.restart` | ✓ | ✓ | | | |
| `deployments.scale` | ✓ | ✓ | | | |
| `deployments.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `deployments.rollback` | ✓ | ✓ | ✓ | | |

### Databases

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `databases.provision` | ✓ | ✓ | | | |
| `databases.backup` | ✓ | ✓ | | | |
| `databases.restore` | ✓ | ✓ | | | |
| `databases.delete` | ✓ | ✓ | | | |
| `databases.create-connection` | ✓ | ✓ | | | |
| `databases.delete-connection` | ✓ | ✓ | | | |
| `databases.read` | ✓ | ✓ | ✓ | ✓ | |

### Config / Feature Flags

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `config.read` | ✓ | ✓ | ✓ | ✓ | |
| `config.update` | ✓ | ✓ | ✓ | | |
| `config.delete` | ✓ | ✓ | | | |
| `config.manage-feature-flags` | ✓ | ✓ | ✓ | | |

### Secrets

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `secrets.list` | ✓ | ✓ | ✓ | | |
| `secrets.read` | ✓ | ✓ | ✓ | | |
| `secrets.reveal` | ✓ | ✓ | | | |
| `secrets.create` | ✓ | ✓ | ✓ | | |
| `secrets.update` | ✓ | ✓ | ✓ | | |
| `secrets.delete` | ✓ | ✓ | | | |
| `secrets.export` | ✓ | ✓ | ✓ | | |
| `secrets.import` | ✓ | ✓ | ✓ | | |
| `secrets.rollback` | ✓ | ✓ | | | |

### Alerts

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `alerts.list` | ✓ | ✓ | ✓ | ✓ | |
| `alerts.create` | ✓ | ✓ | ✓ | | |
| `alerts.update` | ✓ | ✓ | ✓ | | |
| `alerts.delete` | ✓ | ✓ | | | |

### Logs & Metrics

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `logs.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `logs.search` | ✓ | ✓ | ✓ | | |
| `metrics.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `metrics.read-rpm` | ✓ | ✓ | ✓ | | |

### Settings

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `settings.smtp.read` | ✓ | ✓ | | | |
| `settings.smtp.manage` | ✓ | ✓ | | | |
| `settings.storage.read` | ✓ | ✓ | | | |
| `settings.storage.manage` | ✓ | ✓ | | | |

### Cluster / Infrastructure

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `cluster.read` | ✓ | ✓ | | | |
| `cluster.manage` | ✓ | ✓ | | | |
| `cluster.pods.read` | ✓ | ✓ | | | |
| `cluster.pods.delete` | ✓ | ✓ | | | |

### CI/CD

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `cicd.register-webhook` | ✓ | ✓ | | | |
| `cicd.read` | ✓ | ✓ | ✓ | | |

### Bootstrap

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `bootstrap.init` | ✓ | ✓ | | | |
| `bootstrap.read` | ✓ | ✓ | | | |

### Audit

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `audit.read` | ✓ | ✓ | ✓ | | |

### SDK

| Permission | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| `sdk.send-logs` | ✓ | ✓ | | | |
| `sdk.send-metrics` | ✓ | ✓ | | | |
| `sdk.send-bug-reports` | ✓ | ✓ | | | |

---

## Compact Summary

| Category | admin | devops | tech_lead | developer | viewer |
|---|---|---|---|---|---|
| Auth | 2/2 | 2/2 | 1/2 | 1/2 | 1/2 |
| Users | 6/6 | 6/6 | 2/6 | 1/6 | 0/6 |
| Projects | 5/5 | 5/5 | 4/5 | 3/5 | 2/5 |
| Deployments | 6/6 | 6/6 | 4/6 | 2/6 | 1/6 |
| Databases | 7/7 | 7/7 | 1/7 | 1/7 | 0/7 |
| Config | 4/4 | 4/4 | 3/4 | 1/4 | 0/4 |
| Secrets | 9/9 | 9/9 | 6/9 | 0/9 | 0/9 |
| Alerts | 4/4 | 4/4 | 3/4 | 1/4 | 0/4 |
| Logs & Metrics | 4/4 | 4/4 | 4/4 | 2/4 | 2/4 |
| Settings | 4/4 | 4/4 | 0/4 | 0/4 | 0/4 |
| Cluster | 4/4 | 4/4 | 0/4 | 0/4 | 0/4 |
| CI/CD | 2/2 | 2/2 | 1/2 | 0/2 | 0/2 |
| Bootstrap | 2/2 | 2/2 | 0/2 | 0/2 | 0/2 |
| Audit | 1/1 | 1/1 | 1/1 | 0/1 | 0/1 |
| SDK | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 |
| **Total** | **63/63** | **63/63** | **30/63** | **12/63** | **6/63** |

> Permissions are defined in `platform/api/src/config/permissions.ts`. The admin role inherits all 48 permission keys (mapped to 63 entries in the counting above due to multi-value permissions like `users.*`).
