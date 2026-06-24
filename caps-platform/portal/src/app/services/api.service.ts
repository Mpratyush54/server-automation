import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private base = '/api';

  constructor(private http: HttpClient) {}

  // Projects
  getProjects(): Observable<any> { return this.http.get(`${this.base}/projects`); }
  getProject(id: string): Observable<any> { return this.http.get(`${this.base}/projects/${id}`); }
  createProject(data: any): Observable<any> { return this.http.post(`${this.base}/projects`, data); }
  updateProject(id: string, data: any): Observable<any> { return this.http.put(`${this.base}/projects/${id}`, data); }
  deleteProject(id: string): Observable<any> { return this.http.delete(`${this.base}/projects/${id}`); }

  // Deployments
  deploy(data: any): Observable<any> { return this.http.post(`${this.base}/deploy`, data); }
  rollback(data: any): Observable<any> { return this.http.post(`${this.base}/rollback`, data); }
  restartDeployment(id: string): Observable<any> { return this.http.post(`${this.base}/deployments/${id}/restart`, {}); }
  getProjectDeployments(projectId: string): Observable<any> { return this.http.get(`${this.base}/deployments/${projectId}`); }
  getDeployment(id: string): Observable<any> { return this.http.get(`${this.base}/deployments/${id}`); }
  terminateDeployment(id: string): Observable<any> { return this.http.post(`${this.base}/deployments/${id}/terminate`, {}); }

  // SDK
  registerService(data: any): Observable<any> { return this.http.post(`${this.base}/sdk/register`, data); }
  sendHeartbeat(data: any): Observable<any> { return this.http.post(`${this.base}/sdk/heartbeat`, data); }
  getSdkConfig(projectId: string, envId?: string): Observable<any> { return this.http.get(`${this.base}/sdk/config`, { params: { projectId, ...(envId ? { environmentId: envId } : {}) } }); }
  getDbCredentials(projectId: string, dbTypes: string): Observable<any> { return this.http.get(`${this.base}/sdk/db-credentials`, { params: { projectId, dbTypes } }); }

  // Metrics
  getMetrics(projectId: string, serviceName?: string): Observable<any> { return this.http.get(`${this.base}/metrics`, { params: { projectId, ...(serviceName ? { serviceName } : {}) } }); }
  getAggregatedMetrics(projectId: string): Observable<any> { return this.http.get(`${this.base}/metrics/aggregated`, { params: { projectId } }); }

  // Logs
  searchLogs(params: any): Observable<any> { return this.http.get(`${this.base}/logs/search`, { params }); }

  // Config
  getConfig(projectId: string, envId?: string): Observable<any> { return this.http.get(`${this.base}/config`, { params: { projectId, ...(envId ? { environmentId: envId } : {}) } }); }
  setConfig(data: any): Observable<any> { return this.http.post(`${this.base}/config`, data); }
  deleteConfig(projectId: string, key: string): Observable<any> { return this.http.delete(`${this.base}/config`, { params: { projectId, key } }); }
  setFeatureFlag(data: any): Observable<any> { return this.http.post(`${this.base}/config/feature-flags`, data); }

  // Storage
  getUploadUrl(data: any): Observable<any> { return this.http.post(`${this.base}/storage/upload-url`, data); }
  deleteFile(fileId: string): Observable<any> { return this.http.post(`${this.base}/storage/delete`, { fileId }); }
  getFile(id: string): Observable<any> { return this.http.get(`${this.base}/storage/file/${id}`); }
  getProjectFiles(projectId: string): Observable<any> { return this.http.get(`${this.base}/storage/project/${projectId}`); }
  getStorageAnalytics(projectId: string): Observable<any> { return this.http.get(`${this.base}/storage/analytics/${projectId}`); }

  // Bootstrap & Kubernetes
  bootstrapInit(data: any): Observable<any> { return this.http.post(`${this.base}/bootstrap/init`, data); }
  getBootstrapStatus(): Observable<any> { return this.http.get(`${this.base}/bootstrap/status`); }
  getBootstrapToken(): Observable<any> { return this.http.get(`${this.base}/bootstrap/token`); }
  getNodes(): Observable<any> { return this.http.get(`${this.base}/bootstrap/nodes`); }
  getBootstrapHistory(): Observable<any> { return this.http.get(`${this.base}/bootstrap/history`); }
  getNamespaces(): Observable<any> { return this.http.get(`${this.base}/bootstrap/namespaces`); }
  getPods(namespace?: string): Observable<any> { return this.http.get(`${this.base}/bootstrap/pods`, { params: namespace ? { namespace } : {} }); }
  getPodLogs(namespace: string, name: string): Observable<any> { return this.http.get(`${this.base}/bootstrap/pods/${namespace}/${name}/logs`); }
  deletePod(namespace: string, name: string): Observable<any> { return this.http.delete(`${this.base}/bootstrap/pods/${namespace}/${name}`); }

  // SDK Project Tokens
  getProjectTokens(projectId: string): Observable<any> { return this.http.get(`${this.base}/projects/${projectId}/tokens`); }
  createProjectToken(projectId: string, name: string): Observable<any> { return this.http.post(`${this.base}/projects/${projectId}/tokens`, { name }); }
  deleteProjectToken(projectId: string, tokenId: string): Observable<any> { return this.http.delete(`${this.base}/projects/${projectId}/tokens/${tokenId}`); }
  getArgoCDStatus(projectId: string): Observable<any> { return this.http.get(`${this.base}/projects/${projectId}/argocd-status`); }

  // API Metrics (from Node.js SDK middleware)
  getApiMetrics(projectId: string, environment?: string): Observable<any> {
    return this.http.get(`${this.base}/sdk/api-metrics`, { params: { projectId, ...(environment ? { environment } : {}) } });
  }

  // Database Provisioning
  provisionDatabase(projectId: string, environment: string): Observable<any> { return this.http.post(`${this.base}/projects/${projectId}/databases/provision`, { environment }); }
  getDbBackups(projectId: string, dbId: string): Observable<any> { return this.http.get(`${this.base}/projects/${projectId}/databases/${dbId}/backups`); }
  triggerBackup(projectId: string, dbId: string): Observable<any> { return this.http.post(`${this.base}/projects/${projectId}/databases/${dbId}/backup`, {}); }
  restoreBackup(projectId: string, dbId: string, backupId: string): Observable<any> { return this.http.post(`${this.base}/projects/${projectId}/databases/${dbId}/backups/${backupId}/restore`, {}); }

  // SMTP Settings
  getSmtpConfigs(): Observable<any> { return this.http.get(`${this.base}/settings/smtp`); }
  createSmtpConfig(data: any): Observable<any> { return this.http.post(`${this.base}/settings/smtp`, data); }
  testSmtpConfig(id: string, testTo: string): Observable<any> { return this.http.post(`${this.base}/settings/smtp/${id}/test`, { testTo }); }
  deleteSmtpConfig(id: string): Observable<any> { return this.http.delete(`${this.base}/settings/smtp/${id}`); }

  // Storage Settings
  getStorageProviders(): Observable<any> { return this.http.get(`${this.base}/settings/storage`); }
  createStorageProvider(data: any): Observable<any> { return this.http.post(`${this.base}/settings/storage`, data); }
  testStorageProvider(id: string): Observable<any> { return this.http.post(`${this.base}/settings/storage/${id}/test`, {}); }
  setDefaultStorage(id: string): Observable<any> { return this.http.patch(`${this.base}/settings/storage/${id}/set-default`, {}); }
  deleteStorageProvider(id: string): Observable<any> { return this.http.delete(`${this.base}/settings/storage/${id}`); }

  // Bug Reporting
  submitBugReport(data: any): Observable<any> { return this.http.post(`${this.base}/sdk/bug-report`, data); }

  // CI/CD
  getGitlabCiYml(projectName: string, stack: string): Observable<any> { return this.http.get(`${this.base}/cicd/gitlab-ci`, { params: { projectName, stack } }); }
  getDockerfile(stack: string): Observable<any> { return this.http.get(`${this.base}/cicd/dockerfile`, { params: { stack } }); }
  getHelmChart(projectName: string, stack: string): Observable<any> { return this.http.get(`${this.base}/cicd/helm`, { params: { projectName, stack } }); }
  getK8sManifests(projectName: string): Observable<any> { return this.http.get(`${this.base}/cicd/kubernetes`, { params: { projectName } }); }

  // Alerts
  getAlerts(projectId?: string): Observable<any> { return this.http.get(`${this.base}/alerts`, { params: projectId ? { projectId } : {} }); }
  createAlert(data: any): Observable<any> { return this.http.post(`${this.base}/alerts`, data); }
  updateAlert(id: string, data: any): Observable<any> { return this.http.put(`${this.base}/alerts/${id}`, data); }
  deleteAlert(id: string): Observable<any> { return this.http.delete(`${this.base}/alerts/${id}`); }
  evaluateAlerts(projectId: string, metrics: any): Observable<any> { return this.http.post(`${this.base}/alerts/evaluate`, { projectId, metrics }); }

  // DB Connections
  getDbConnections(projectId?: string): Observable<any> { return this.http.get(`${this.base}/db-connections`, { params: projectId ? { projectId } : {} }); }
  createDbConnection(data: any): Observable<any> { return this.http.post(`${this.base}/db-connections`, data); }
  testDbConnection(id: string): Observable<any> { return this.http.post(`${this.base}/db-connections/${id}/test`, {}); }
  deleteDbConnection(id: string): Observable<any> { return this.http.delete(`${this.base}/db-connections/${id}`); }

  // Authentication & Users
  login(email: string): Observable<any> { return this.http.post(`${this.base}/auth/login`, { email }); }
  initDemoUsers(): Observable<any> { return this.http.get(`${this.base}/users/init-demo`); }
  getUsers(): Observable<any> { return this.http.get(`${this.base}/users`); }
  createUser(data: any): Observable<any> { return this.http.post(`${this.base}/users`, data); }
  updateUser(id: string, data: any): Observable<any> { return this.http.put(`${this.base}/users/${id}`, data); }
  deleteUser(id: string): Observable<any> { return this.http.delete(`${this.base}/users/${id}`); }
}
