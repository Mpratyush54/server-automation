import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

export type StatusIncidentLifecycle =
  | 'investigating'
  | 'identified'
  | 'monitoring'
  | 'resolved'
  | 'scheduled';

export type StatusIncidentImpact = 'none' | 'minor' | 'major' | 'critical';

export interface StatusIncidentUpdate {
  at: string;
  status: StatusIncidentLifecycle;
  body: string;
  by?: string | null;
}

/**
 * Manual incident / maintenance note on a status page (#46). Distinct from
 * alert_incidents (#43): these are operator-authored timeline entries for the
 * public page.
 */
@Entity('status_incidents')
@Index('status_incidents_page', ['statusPageId', 'createdAt'])
@Index('status_incidents_project', ['projectId'])
export class StatusIncident {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'status_page_id' })
  statusPageId: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 20, default: 'investigating' })
  status: StatusIncidentLifecycle;

  @Column({ type: 'varchar', length: 20, default: 'minor' })
  impact: StatusIncidentImpact;

  @Column({ type: 'boolean', name: 'is_maintenance', default: false })
  isMaintenance: boolean;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  updates: StatusIncidentUpdate[];

  @Column({ type: 'timestamp', name: 'scheduled_start', nullable: true })
  scheduledStart: Date | null;

  @Column({ type: 'timestamp', name: 'scheduled_end', nullable: true })
  scheduledEnd: Date | null;

  @Column({ type: 'timestamp', name: 'resolved_at', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
