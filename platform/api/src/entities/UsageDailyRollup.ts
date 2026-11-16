import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, Unique,
} from 'typeorm';

/**
 * One calendar-day usage snapshot for a project environment (#57).
 * Metrics are already converted to billing-friendly units (core-hours, GB-hours, …).
 */
@Entity('usage_daily_rollups')
@Unique('UQ_usage_daily_project_env_day', ['projectId', 'environmentId', 'day'])
@Index('IDX_usage_daily_project_day', ['projectId', 'day'])
@Index('IDX_usage_daily_day', ['day'])
export class UsageDailyRollup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  /** Null = project-wide aggregate row (object storage that is not env-scoped). */
  @Column({ type: 'uuid', nullable: true, name: 'environment_id' })
  environmentId: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'environment_name' })
  environmentName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  namespace: string | null;

  /** Calendar day in UTC (date only). */
  @Column({ type: 'date' })
  day: string;

  @Column({ type: 'double precision', name: 'cpu_core_hours', default: 0 })
  cpuCoreHours: number;

  @Column({ type: 'double precision', name: 'memory_gb_hours', default: 0 })
  memoryGbHours: number;

  @Column({ type: 'double precision', name: 'pvc_storage_gb', default: 0 })
  pvcStorageGb: number;

  @Column({ type: 'double precision', name: 'object_storage_gb', default: 0 })
  objectStorageGb: number;

  @Column({ type: 'double precision', name: 'ingress_bandwidth_gb', default: 0 })
  ingressBandwidthGb: number;

  @Column({ type: 'double precision', name: 'build_minutes', default: 0 })
  buildMinutes: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
