import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SyntheticCheckType = 'http' | 'multistep' | 'browser' | 'ssl';
export type SyntheticStatus = 'up' | 'down' | 'degraded' | 'unknown';
export type SyntheticAlertState = 'ok' | 'warning' | 'firing';

export interface SyntheticAlertPolicy {
  enabled: boolean;
  /** Consecutive failed runs before the alert fires (default 2). */
  failureThreshold: number;
  severity: 'warning' | 'critical';
}

/**
 * A per-project synthetic check (#42). `config` holds the non-secret definition
 * (URL, steps, assertions); `secretsEncrypted` holds `{ NAME: value }` encrypted with
 * SECRETS_ENCRYPTION_KEY and is never returned by the API (only the names are).
 * The last-run state columns drive scheduling, alerting, metrics and the status feed.
 */
@Entity('synthetic_checks')
@Index('synthetic_checks_project', ['projectId'])
@Index('synthetic_checks_due', ['enabled', 'nextRunAt'])
export class SyntheticCheck {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'uuid', name: 'environment_id', nullable: true })
  environmentId: string | null;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  type: SyntheticCheckType;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'int', name: 'interval_seconds', default: 300 })
  intervalSeconds: number;

  @Column({ type: 'int', name: 'timeout_ms', default: 10000 })
  timeoutMs: number;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  config: Record<string, any>;

  @Column({ type: 'text', name: 'secrets_encrypted', nullable: true })
  secretsEncrypted: string | null;

  /** Probe locations; only `local` (the cluster itself) exists today. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  locations: string[];

  /** Empty means the defaults (enabled, 2 consecutive failures, critical); see normaliseAlertPolicy. */
  @Column({ type: 'jsonb', name: 'alert_policy', default: () => "'{}'" })
  alertPolicy: SyntheticAlertPolicy;

  @Column({ type: 'timestamp', name: 'next_run_at', nullable: true })
  nextRunAt: Date | null;

  @Column({ type: 'timestamp', name: 'last_run_at', nullable: true })
  lastRunAt: Date | null;

  @Column({ type: 'varchar', length: 20, name: 'last_status', default: 'unknown' })
  lastStatus: SyntheticStatus;

  @Column({ type: 'int', name: 'last_latency_ms', nullable: true })
  lastLatencyMs: number | null;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError: string | null;

  @Column({ type: 'int', name: 'consecutive_failures', default: 0 })
  consecutiveFailures: number;

  @Column({ type: 'varchar', length: 20, name: 'alert_state', default: 'ok' })
  alertState: SyntheticAlertState;

  @Column({ type: 'timestamp', name: 'ssl_expires_at', nullable: true })
  sslExpiresAt: Date | null;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
