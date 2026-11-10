import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export interface EscalationStep {
  /** Minutes after the incident opened (step 0 is always immediate). */
  delayMinutes: number;
  channelIds?: string[];
  scheduleIds?: string[];
  userIds?: string[];
}

/** "Notify A, after N minutes notify B" (#43). Acknowledging an incident stops escalation. */
@Entity('alert_escalation_policies')
@Index('alert_policies_project', ['projectId'])
export class AlertEscalationPolicy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'boolean', default: false, name: 'is_default' })
  isDefault: boolean;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  steps: EscalationStep[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
