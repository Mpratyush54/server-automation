import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, Unique,
} from 'typeorm';

/**
 * Per-project soft/hard usage quotas (#57). Hard resource limits are also applied
 * to the environment ResourceQuota (requests/limits/storage) when set.
 */
@Entity('usage_quotas')
@Unique('UQ_usage_quota_project', ['projectId'])
@Index('IDX_usage_quota_project', ['projectId'])
export class UsageQuota {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  /** Monthly CPU core-hours cap (null = unlimited). */
  @Column({ type: 'double precision', nullable: true, name: 'cpu_core_hours' })
  cpuCoreHours: number | null;

  /** Monthly memory GB-hours cap. */
  @Column({ type: 'double precision', nullable: true, name: 'memory_gb_hours' })
  memoryGbHours: number | null;

  /** Peak combined PVC + object storage GB. */
  @Column({ type: 'double precision', nullable: true, name: 'storage_gb' })
  storageGb: number | null;

  /** Monthly ingress bandwidth GB. */
  @Column({ type: 'double precision', nullable: true, name: 'bandwidth_gb' })
  bandwidthGb: number | null;

  /** Monthly build minutes. */
  @Column({ type: 'double precision', nullable: true, name: 'build_minutes' })
  buildMinutes: number | null;

  /**
   * ResourceQuota hard overrides applied to every project namespace
   * (e.g. requests.cpu, requests.memory, requests.storage, pods).
   */
  @Column({ type: 'jsonb', nullable: true, name: 'resource_quota' })
  resourceQuota: Record<string, string> | null;

  @Column({ type: 'boolean', default: true, name: 'alerts_enabled' })
  alertsEnabled: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
