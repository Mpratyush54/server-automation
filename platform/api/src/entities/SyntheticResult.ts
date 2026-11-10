import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type SyntheticResultStatus = 'pass' | 'fail' | 'degraded';

/** One run of a synthetic check (#42). Pruned after SYNTHETICS_RETENTION_DAYS. */
@Entity('synthetic_results')
@Index('synthetic_results_check_time', ['checkId', 'startedAt'])
@Index('synthetic_results_project_time', ['projectId', 'startedAt'])
export class SyntheticResult {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'check_id' })
  checkId: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 20 })
  status: SyntheticResultStatus;

  @Column({ type: 'int', name: 'latency_ms', nullable: true })
  latencyMs: number | null;

  @Column({ type: 'int', name: 'status_code', nullable: true })
  statusCode: number | null;

  /** Redacted error message (secret values are never stored). */
  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'jsonb', nullable: true })
  assertions: any[] | null;

  /** Per-step results for multi-step / browser checks. */
  @Column({ type: 'jsonb', nullable: true })
  steps: any[] | null;

  @Column({ type: 'timestamp', name: 'ssl_expires_at', nullable: true })
  sslExpiresAt: Date | null;

  /** Object key of the failure screenshot (browser checks) in the uploads bucket. */
  @Column({ type: 'varchar', length: 300, name: 'screenshot_key', nullable: true })
  screenshotKey: string | null;

  @Column({ type: 'varchar', length: 40, default: 'local' })
  location: string;

  @Column({ type: 'timestamp', name: 'started_at' })
  startedAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
