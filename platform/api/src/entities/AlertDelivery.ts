import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

/** One notification to send (#43): a channel or an on-call user, retried with backoff by the leader. */
@Entity('alert_deliveries')
@Index('alert_deliveries_status', ['status'])
@Index('alert_deliveries_incident', ['incidentId'])
@Index('alert_deliveries_created', ['createdAt'])
export class AlertDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'incident_id' })
  incidentId: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'uuid', nullable: true, name: 'channel_id' })
  channelId: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  /** firing | resolved | acknowledged | escalation */
  @Column({ type: 'varchar', length: 20 })
  event: string;

  /** pending | sent | failed | skipped */
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamp', name: 'next_attempt_at' })
  nextAttemptAt: Date;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError: string | null;

  @Column({ type: 'timestamp', nullable: true, name: 'sent_at' })
  sentAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
