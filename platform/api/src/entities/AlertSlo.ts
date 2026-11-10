import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * `ratio`        custom PromQL: errorQuery / totalQuery, both containing `$window`
 * `availability` non-error share of a service's spans (Tempo span metrics)
 * `latency`      share of a service's spans faster than params.latencyMs
 */
export type AlertSliType = 'ratio' | 'availability' | 'latency';

/** Service level objective (#43) with Sloth-style recording rules and multi-window burn-rate alerts. */
@Entity('alert_slos')
@Index('alert_slos_project', ['projectId'])
export class AlertSlo {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 150 })
  name: string;

  @Column({ type: 'varchar', length: 20, name: 'sli_type' })
  sliType: AlertSliType;

  @Column({ type: 'text', nullable: true, name: 'error_query' })
  errorQuery: string | null;

  @Column({ type: 'text', nullable: true, name: 'total_query' })
  totalQuery: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  params: Record<string, any>;

  /** Objective in percent, e.g. 99.9. */
  @Column({ type: 'double precision' })
  target: number;

  @Column({ type: 'int', default: 30, name: 'window_days' })
  windowDays: number;

  @Column({ type: 'uuid', nullable: true, name: 'policy_id' })
  policyId: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** Last computed status (error ratio, burn rates, error budget remaining). */
  @Column({ type: 'jsonb', nullable: true })
  status: Record<string, any> | null;

  /** API evaluator: firing state per burn-rate alert (page / ticket). */
  @Column({ type: 'jsonb', default: () => "'{}'", name: 'alert_state' })
  alertState: Record<string, string>;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
