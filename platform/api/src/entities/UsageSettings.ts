import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

/**
 * Singleton row of platform-wide unit prices and optional monthly server cost (#57).
 * Costs are estimates only — no billing/payment integration.
 */
@Entity('usage_settings')
export class UsageSettings {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'double precision', name: 'per_core_hour', default: 0.04 })
  perCoreHour: number;

  @Column({ type: 'double precision', name: 'per_gb_hour_memory', default: 0.005 })
  perGbHourMemory: number;

  /** Combined PVC + object storage, billed as GB-month (daily = /30). */
  @Column({ type: 'double precision', name: 'per_gb_month_storage', default: 0.02 })
  perGbMonthStorage: number;

  @Column({ type: 'double precision', name: 'per_gb_bandwidth', default: 0.09 })
  perGbBandwidth: number;

  @Column({ type: 'double precision', name: 'per_build_minute', default: 0.002 })
  perBuildMinute: number;

  /**
   * Optional fixed monthly server cost. When > 0, allocated across projects
   * in proportion to their metered usage share for the period.
   */
  @Column({ type: 'double precision', name: 'monthly_server_cost', default: 0 })
  monthlyServerCost: number;

  @Column({ type: 'varchar', length: 8, default: 'USD' })
  currency: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
