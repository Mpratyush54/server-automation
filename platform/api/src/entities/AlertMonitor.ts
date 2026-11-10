import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * `metric`   PromQL (Prometheus)
 * `log`      LogQL metric query (Loki)
 * `trace`    error rate / latency / request rate of a service from Tempo span metrics
 * `resource` CPU / memory of the project's namespaces (also the target of migrated legacy alerts)
 */
export type AlertMonitorKind = 'metric' | 'log' | 'trace' | 'resource';

/** A threshold rule (#43), rendered to a PrometheusRule (full profile) or evaluated by the API. */
@Entity('alert_monitors')
@Index('alert_monitors_project', ['projectId'])
@Index('alert_monitors_legacy', ['legacyAlertId'], { unique: true, where: 'legacy_alert_id IS NOT NULL' })
export class AlertMonitor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 150 })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  kind: AlertMonitorKind;

  @Column({ type: 'text', nullable: true })
  query: string | null;

  /** trace: { service?, signal }, resource: { resource }, all: { environment? }. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  params: Record<string, any>;

  @Column({ type: 'varchar', length: 4, default: '>' })
  operator: string;

  @Column({ type: 'double precision', default: 0 })
  threshold: number;

  @Column({ type: 'int', default: 300, name: 'for_seconds' })
  forSeconds: number;

  @Column({ type: 'varchar', length: 20, default: 'warning' })
  severity: string;

  @Column({ type: 'uuid', nullable: true, name: 'policy_id' })
  policyId: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  labels: Record<string, string>;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** Row in the legacy `alerts` table this monitor was migrated from / mirrors. */
  @Column({ type: 'uuid', nullable: true, name: 'legacy_alert_id' })
  legacyAlertId: string | null;

  /** API evaluator state: ok | pending | firing. */
  @Column({ type: 'varchar', length: 20, default: 'ok' })
  state: string;

  @Column({ type: 'timestamp', nullable: true, name: 'pending_since' })
  pendingSince: Date | null;

  @Column({ type: 'double precision', nullable: true, name: 'last_value' })
  lastValue: number | null;

  @Column({ type: 'timestamp', nullable: true, name: 'last_evaluated_at' })
  lastEvaluatedAt: Date | null;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
