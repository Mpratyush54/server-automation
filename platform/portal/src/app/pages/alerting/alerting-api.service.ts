import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type AlertingCollection = 'channels' | 'monitors' | 'slos' | 'silences' | 'policies' | 'schedules' | 'incidents';

/** Client for /api/projects/:projectId/alerting/* (#43). */
@Injectable({ providedIn: 'root' })
export class AlertingApiService {
  private base = '/api';

  constructor(private http: HttpClient) {}

  status(): Observable<any> { return this.http.get(`${this.base}/alerting/status`); }
  allIncidents(status = 'open'): Observable<any[]> { return this.http.get<any[]>(`${this.base}/alerting/incidents`, { params: { status } }); }

  list(projectId: string, what: AlertingCollection, params: Record<string, string> = {}): Observable<any[]> {
    return this.http.get<any[]>(`${this.base}/projects/${projectId}/alerting/${what}`, { params });
  }
  create(projectId: string, what: AlertingCollection, body: any): Observable<any> {
    return this.http.post(`${this.base}/projects/${projectId}/alerting/${what}`, body);
  }
  update(projectId: string, what: AlertingCollection, id: string, body: any): Observable<any> {
    return this.http.put(`${this.base}/projects/${projectId}/alerting/${what}/${id}`, body);
  }
  remove(projectId: string, what: AlertingCollection, id: string): Observable<any> {
    return this.http.delete(`${this.base}/projects/${projectId}/alerting/${what}/${id}`);
  }

  testChannel(projectId: string, id: string): Observable<any> { return this.http.post(`${this.base}/projects/${projectId}/alerting/channels/${id}/test`, {}); }
  sloStatus(projectId: string, id: string, refresh = false): Observable<any> {
    return this.http.get(`${this.base}/projects/${projectId}/alerting/slos/${id}/status`, { params: refresh ? { refresh: '1' } : {} });
  }
  ack(projectId: string, id: string): Observable<any> { return this.http.post(`${this.base}/projects/${projectId}/alerting/incidents/${id}/ack`, {}); }
  resolve(projectId: string, id: string): Observable<any> { return this.http.post(`${this.base}/projects/${projectId}/alerting/incidents/${id}/resolve`, {}); }
  testEvent(projectId: string, status: 'firing' | 'resolved'): Observable<any> {
    return this.http.post(`${this.base}/projects/${projectId}/alerting/test-event`, { key: 'portal', status });
  }
}
