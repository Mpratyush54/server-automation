import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-project-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './project-detail.component.html',
  styleUrl: './project-detail.component.css'
})
export class ProjectDetailComponent implements OnInit, OnDestroy {
  project: any;
  deployments: any[] = [];
  configs: Record<string, string> = {};
  files: any[] = [];
  logs: any[] = [];
  metrics: any[] = [];
  aggregatedMetrics: any = { cpuAvg: 0, memoryAvg: 0, errorRate: 0 };
  storageAnalytics: any = { totalBytes: 0, count: 0, providerBreakdown: {} };
  dbConnections: any[] = [];

  activeTab = 'deployments';
  role = 'devops';

  // SDK Tokens
  tokens: any[] = [];
  newKeyName = '';
  generatedKeyPlaintext = '';

  // GitOps / ArgoCD Pods
  pods: any[] = [];
  k8sConnected = false;
  argoStatus: any = null;

  // API Metrics
  apiMetrics: any[] = [];

  // Databases
  newDb = { dbType: 'postgres', poolSize: 10 };
  testingDbId = '';
  provisioningDb = false;
  provisionedCreds: any = null;

  // Backups
  dbBackups: any[] = [];
  backupDbName = '';
  backupInProgress = false;

  // Form DTOs
  deployDto = { version: '1.0.0', branch: 'feature/CU-123-auth', environmentId: '', commitSha: 'a3f92c1', imageTag: 'v1.0.0' };
  newConfig = { key: '', value: '', environmentId: '', isSecret: false };
  newFileCategoryRoute = { category: '', provider: 'local' };
  searchLogQuery = { level: '', search: '' };

  // Secrets
  secrets: any[] = [];
  newSecret = { key: '', value: '', environmentId: '' };
  activeSecretVersions: any[] = [];
  activeSecretKey: string = '';
  activeSecretId: string = '';
  showVersionsModal: boolean = false;
  bulkImportText: string = '';
  showBulkImportModal: boolean = false;
  bulkImportEnvId: string = '';
  exportedEnvId: string = '';
  exportedSecretsText: string = '';
  showExportModal: boolean = false;
  
  // Timer for logs & heartbeats refresh
  private refreshTimer?: any;

  constructor(private route: ActivatedRoute, private api: ApiService) {}

  async ngOnInit() {
    const token = localStorage.getItem('caps_auth_token') || '33333333-3333-3333-3333-333333333333';
    if (token === '11111111-1111-1111-1111-111111111111') this.role = 'developer';
    else if (token === '22222222-2222-2222-2222-222222222222') this.role = 'tech_lead';
    else this.role = 'devops';

    await this.fetchData();
    this.refreshTimer = setInterval(() => this.pollData(), 5000);
  }

  ngOnDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.logPollInterval) clearInterval(this.logPollInterval);
  }

  async fetchData() {
    const id = this.route.snapshot.paramMap.get('id')!;
    try {
      this.project = await firstValueFrom(this.api.getProject(id));
      if (this.project?.environments?.length) {
        this.deployDto.environmentId = this.project.environments[0].id;
      }
    } catch { this.project = null; }

    await this.loadDeployments();
    await this.loadConfigs();
    await this.loadFiles();
    await this.loadLogs();
    await this.loadMetrics();
    await this.loadDbConnections();
    await this.loadTokens();
    await this.loadK8sPods();
    await this.loadArgoStatus();
    await this.loadSecrets();
  }

  async pollData() {
    if (this.activeTab === 'logs') await this.loadLogs();
    if (this.activeTab === 'metrics') await this.loadMetrics();
    if (this.activeTab === 'api-metrics') await this.loadApiMetrics();
    if (this.activeTab === 'databases') await this.loadBackups();
    if (this.activeTab === 'secrets') await this.loadSecrets();
    if (this.activeTab === 'gitops') {
      await this.loadK8sPods();
      await this.loadArgoStatus();
    }
  }

  async loadDeployments() {
    if (!this.project) return;
    try {
      this.deployments = await firstValueFrom(this.api.getProjectDeployments(this.project.id));
    } catch { this.deployments = []; }
  }

  async loadConfigs() {
    if (!this.project) return;
    try {
      this.configs = await firstValueFrom(this.api.getConfig(this.project.id));
    } catch { this.configs = {}; }
  }

  async loadFiles() {
    if (!this.project) return;
    try {
      this.files = await firstValueFrom(this.api.getProjectFiles(this.project.id));
      this.storageAnalytics = await firstValueFrom(this.api.getStorageAnalytics(this.project.id));
    } catch { this.files = []; }
  }

  async loadLogs() {
    if (!this.project) return;
    try {
      const res = await firstValueFrom(this.api.searchLogs({
        projectId: this.project.id,
        level: this.searchLogQuery.level,
        search: this.searchLogQuery.search,
        limit: 100
      }));
      this.logs = res.logs || [];
    } catch { this.logs = []; }
  }

  async loadMetrics() {
    if (!this.project) return;
    try {
      this.metrics = await firstValueFrom(this.api.getMetrics(this.project.id));
      this.aggregatedMetrics = await firstValueFrom(this.api.getAggregatedMetrics(this.project.id));
    } catch { this.metrics = []; }
  }

  async loadDbConnections() {
    if (!this.project) return;
    try {
      this.dbConnections = await firstValueFrom(this.api.getDbConnections(this.project.id));
    } catch { this.dbConnections = []; }
  }

  async deploy() {
    try {
      const payload = {
        projectId: this.project.id,
        environmentId: this.deployDto.environmentId,
        version: this.deployDto.version,
        branch: this.deployDto.branch,
        commitSha: this.deployDto.commitSha,
        imageTag: this.deployDto.imageTag
      };
      await firstValueFrom(this.api.deploy(payload));
      await this.loadDeployments();
      this.deployDto.version = '1.0.0';
    } catch (err: any) {
      alert('Deploy failed: ' + (err.error?.error || err.message));
    }
  }

  async rollback(depId: string) {
    try {
      await firstValueFrom(this.api.rollback({ deploymentId: depId }));
      await this.loadDeployments();
    } catch (err: any) {
      alert('Rollback failed: ' + (err.error?.error || err.message));
    }
  }

  async restartDeploy(depId: string) {
    try {
      await firstValueFrom(this.api.restartDeployment(depId));
      await this.loadDeployments();
      alert('Restart initiated');
    } catch (err: any) {
      alert('Failed: ' + (err.error?.error || err.message));
    }
  }

  async addConfig() {
    try {
      await firstValueFrom(this.api.setConfig({
        projectId: this.project.id,
        key: this.newConfig.key,
        value: this.newConfig.value,
        environmentId: this.newConfig.environmentId || null,
        isSecret: this.newConfig.isSecret
      }));
      await this.loadConfigs();
      this.newConfig = { key: '', value: '', environmentId: '', isSecret: false };
    } catch (err: any) {
      alert('Failed to set config: ' + (err.error?.error || err.message));
    }
  }

  async deleteConfig(key: string) {
    if (!confirm(`Delete config key "${key}"?`)) return;
    try {
      await firstValueFrom(this.api.deleteConfig(this.project.id, key));
      await this.loadConfigs();
    } catch (err: any) {
      alert('Failed: ' + (err.error?.error || err.message));
    }
  }

  async deleteFile(fileId: string) {
    if (!confirm('Delete this file?')) return;
    try {
      await firstValueFrom(this.api.deleteFile(fileId));
      await this.loadFiles();
    } catch (err: any) {
      alert('Failed: ' + (err.error?.error || err.message));
    }
  }

  async loadTokens() {
    if (!this.project) return;
    try {
      this.tokens = await firstValueFrom(this.api.getProjectTokens(this.project.id));
    } catch { this.tokens = []; }
  }

  async createToken() {
    if (!this.project || !this.newKeyName.trim()) return;
    try {
      const res = await firstValueFrom(this.api.createProjectToken(this.project.id, this.newKeyName));
      this.generatedKeyPlaintext = res.token;
      this.newKeyName = '';
      await this.loadTokens();
    } catch (err: any) {
      alert('Failed to generate SDK token: ' + (err.error?.error || err.message));
    }
  }

  async revokeToken(tokenId: string) {
    if (!this.project || !confirm('Are you sure you want to revoke this SDK token? The SDK will lose access immediately.')) return;
    try {
      await firstValueFrom(this.api.deleteProjectToken(this.project.id, tokenId));
      await this.loadTokens();
    } catch (err: any) {
      alert('Failed to revoke token: ' + (err.error?.error || err.message));
    }
  }

  clearGeneratedToken() {
    this.generatedKeyPlaintext = '';
  }

  // GitOps / ArgoCD Pods Methods
  async loadK8sPods() {
    if (!this.project) return;
    try {
      const res = await firstValueFrom(this.api.getPods());
      this.k8sConnected = res.k8sConnected;
      const allPods = res.pods || [];
      const projNameLower = this.project.name.toLowerCase();
      this.pods = allPods.filter((pod: any) => 
        pod.name.toLowerCase().includes(projNameLower) || 
        pod.namespace.toLowerCase().includes(projNameLower) ||
        (pod.namespace === 'preview' && pod.name.toLowerCase().includes(projNameLower))
      );
    } catch {
      this.pods = [];
      this.k8sConnected = false;
    }
  }

  async loadArgoStatus() {
    if (!this.project) return;
    try {
      this.argoStatus = await firstValueFrom(this.api.getArgoCDStatus(this.project.id));
    } catch {
      this.argoStatus = {
        connected: false,
        syncStatus: 'Offline',
        healthStatus: 'Unknown'
      };
    }
  }

  async loadApiMetrics() {
    if (!this.project) return;
    try {
      const res = await firstValueFrom(this.api.getApiMetrics(this.project.id));
      this.apiMetrics = res.metrics || [];
    } catch {
      this.apiMetrics = [];
    }
  }

  getSlowestEndpoint(): number {
    if (!this.apiMetrics.length) return 0;
    return Math.max(...this.apiMetrics.map((m: any) => m.p95 || 0));
  }

  getHighestErrorRate(): string {
    if (!this.apiMetrics.length) return '0.0';
    const highest = Math.max(...this.apiMetrics.map((m: any) => {
      const total = m.count || 1;
      return ((m.errors4xx + m.errors5xx) / total) * 100;
    }));
    return highest.toFixed(1);
  }

  // Pod log streamer terminal on project detail
  showLogsModal = false;
  selectedPodName = '';
  selectedPodNamespace = '';
  podLogsText = '';
  loadingLogs = false;
  private logPollInterval?: any;

  async openPodLogs(pod: any) {
    this.selectedPodName = pod.name;
    this.selectedPodNamespace = pod.namespace;
    this.showLogsModal = true;
    this.podLogsText = 'Connecting to pod container logs...';
    await this.fetchPodLogs();

    if (this.logPollInterval) clearInterval(this.logPollInterval);
    this.logPollInterval = setInterval(() => this.fetchPodLogs(), 3000);
  }

  async fetchPodLogs() {
    this.loadingLogs = true;
    try {
      const res = await firstValueFrom(this.api.getPodLogs(this.selectedPodNamespace, this.selectedPodName));
      this.podLogsText = res.logs || 'No log output returned from container.';
    } catch (err: any) {
      this.podLogsText = `Error fetching logs: ${err.message}`;
    } finally {
      this.loadingLogs = false;
    }
  }

  closeLogsModal() {
    this.showLogsModal = false;
    if (this.logPollInterval) {
      clearInterval(this.logPollInterval);
      this.logPollInterval = undefined;
    }
  }

  async restartPod(pod: any) {
    if (!confirm(`Are you sure you want to terminate and restart pod "${pod.name}" in namespace "${pod.namespace}"?`)) {
      return;
    }
    try {
      await firstValueFrom(this.api.deletePod(pod.namespace, pod.name));
      alert(`Pod deletion command sent. Pod will be restarted by the deployment controller.`);
      await this.loadK8sPods();
    } catch (err: any) {
      alert(`Failed to restart pod: ${err.error?.error || err.message}`);
    }
  }

  // Databases Methods
  async provisionDb(environment: string) {
    if (!this.project) return;
    if (!confirm(`This will create a new isolated PostgreSQL database for "${this.project.name}" in ${environment}. Continue?`)) return;
    this.provisioningDb = true;
    this.provisionedCreds = null;
    try {
      const res = await firstValueFrom(this.api.provisionDatabase(this.project.id, environment));
      this.provisionedCreds = res;
      await this.loadDbConnections();
    } catch (err: any) {
      alert('Database provisioning failed: ' + (err.error?.error || err.message));
    } finally {
      this.provisioningDb = false;
    }
  }

  dismissProvisionedCreds() {
    this.provisionedCreds = null;
  }

  async loadBackups() {
    if (!this.project) return;
    try {
      this.dbBackups = await firstValueFrom(this.api.getDbBackups(this.project.id, ''));
    } catch {
      this.dbBackups = [];
    }
  }

  async triggerBackup() {
    if (!this.project || !this.backupDbName.trim()) {
      alert('Please enter a database name to backup.');
      return;
    }
    if (!confirm(`Backup "${this.backupDbName}"? This may take a while depending on database size.`)) return;
    this.backupInProgress = true;
    try {
      await firstValueFrom(this.api.triggerBackup(this.project.id, this.backupDbName));
      alert('Backup started! Refresh the list in a minute to check status.');
      setTimeout(() => this.loadBackups(), 3000);
    } catch (err: any) {
      alert('Backup failed: ' + (err.error?.error || err.message));
    } finally {
      this.backupInProgress = false;
    }
  }

  async restoreBackup(backup: any) {
    if (!this.project) return;
    if (!confirm(`Restore "${backup.dbName}" from backup created at ${new Date(backup.createdAt).toLocaleString()}? This will OVERWRITE the current database contents.`)) return;
    try {
      await firstValueFrom(this.api.restoreBackup(this.project.id, 'db', backup.id));
      alert('Restore started! Check the backup status in a moment.');
      setTimeout(() => this.loadBackups(), 3000);
    } catch (err: any) {
      alert('Restore failed: ' + (err.error?.error || err.message));
    }
  }

  async addDbConnection() {
    if (!this.project) return;
    try {
      const payload = {
        projectId: this.project.id,
        dbType: this.newDb.dbType,
        poolSize: this.newDb.poolSize
      };
      await firstValueFrom(this.api.createDbConnection(payload));
      await this.loadDbConnections();
      alert('Database connection configured successfully!');
    } catch (err: any) {
      alert('Failed to configure database: ' + (err.error?.error || err.message));
    }
  }

  async testDbConnection(id: string) {
    this.testingDbId = id;
    try {
      const res = await firstValueFrom(this.api.testDbConnection(id));
      alert(`Connection test passed!\nStatus: ${res.status}\nLatency: ${res.latencyMs}ms`);
      await this.loadDbConnections();
    } catch (err: any) {
      alert('Connection test failed: ' + (err.error?.error || err.message));
    } finally {
      this.testingDbId = '';
    }
  }

  async deleteDbConnection(id: string) {
    if (!confirm('Are you sure you want to delete/disconnect this database connection?')) return;
    try {
      await firstValueFrom(this.api.deleteDbConnection(id));
      await this.loadDbConnections();
    } catch (err: any) {
      alert('Failed to delete connection: ' + (err.error?.error || err.message));
    }
  }

  switchTab(tab: string) {
    this.activeTab = tab;
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  getEnvName(envId: string | null): string {
    if (!envId) return 'GLOBAL';
    const env = this.project?.environments?.find((e: any) => e.id === envId);
    return env ? env.name.toUpperCase() : envId.toUpperCase();
  }

  async loadSecrets() {
    if (!this.project) return;
    try {
      this.secrets = await firstValueFrom(this.api.getSecrets(this.project.id));
    } catch { this.secrets = []; }
  }

  async addSecret() {
    if (!this.project) return;
    try {
      await firstValueFrom(this.api.createOrUpdateSecret(this.project.id, {
        key: this.newSecret.key,
        value: this.newSecret.value,
        environmentId: this.newSecret.environmentId || null
      }));
      await this.loadSecrets();
      this.newSecret = { key: '', value: '', environmentId: '' };
    } catch (err: any) {
      alert('Failed to save secret: ' + (err.error?.error || err.message));
    }
  }

  async deleteSecret(secretId: string) {
    if (!confirm('Are you sure you want to delete this secret?')) return;
    try {
      await firstValueFrom(this.api.deleteSecret(this.project.id, secretId));
      await this.loadSecrets();
    } catch (err: any) {
      alert('Failed to delete secret: ' + (err.error?.error || err.message));
    }
  }

  async revealSecret(secret: any) {
    try {
      const res = await firstValueFrom(this.api.revealSecret(this.project.id, {
        environmentId: secret.environmentId,
        key: secret.key
      }));
      secret.revealedValue = res.value;
      secret.isRevealed = true;
    } catch (err: any) {
      alert('Failed to reveal secret: ' + (err.error?.error || err.message));
    }
  }

  hideSecret(secret: any) {
    secret.isRevealed = false;
    secret.revealedValue = null;
  }

  async showSecretVersions(secret: any) {
    this.activeSecretKey = secret.key;
    this.activeSecretId = secret.id;
    try {
      const res = await firstValueFrom(this.api.getSecretVersions(this.project.id, secret.id));
      this.activeSecretVersions = res.history;
      this.showVersionsModal = true;
    } catch (err: any) {
      alert('Failed to load version history: ' + (err.error?.error || err.message));
    }
  }

  async rollbackToVersion(version: number) {
    if (!confirm(`Rollback secret "${this.activeSecretKey}" to version ${version}?`)) return;
    try {
      await firstValueFrom(this.api.rollbackSecret(this.project.id, this.activeSecretId, version));
      this.showVersionsModal = false;
      await this.loadSecrets();
      alert('Secret successfully rolled back!');
    } catch (err: any) {
      alert('Failed to rollback secret: ' + (err.error?.error || err.message));
    }
  }

  async doBulkImport() {
    if (!this.bulkImportText) return;
    try {
      const lines = this.bulkImportText.split('\n');
      const list: { key: string; value: string }[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
          list.push({ key, value });
        }
      }
      if (list.length === 0) {
        alert('No valid key-value pairs found. Format should be KEY=VALUE.');
        return;
      }
      await firstValueFrom(this.api.bulkImportSecrets(this.project.id, {
        environmentId: this.bulkImportEnvId || null,
        secrets: list
      }));
      this.showBulkImportModal = false;
      this.bulkImportText = '';
      await this.loadSecrets();
      alert(`Imported ${list.length} secrets!`);
    } catch (err: any) {
      alert('Failed to import secrets: ' + (err.error?.error || err.message));
    }
  }

  async doExportSecrets(envId: string) {
    try {
      const res = await firstValueFrom(this.api.exportSecrets(this.project.id, envId));
      this.exportedSecretsText = res.secrets;
      this.exportedEnvId = envId;
      this.showExportModal = true;
    } catch (err: any) {
      alert('Failed to export secrets: ' + (err.error?.error || err.message));
    }
  }
}
