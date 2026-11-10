import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export interface SilenceMatcher {
  name: string;
  value: string;
  isRegex?: boolean;
  isEqual?: boolean;
}

/**
 * Silence or maintenance window of one project (#43). No matchers = the whole project.
 * Enforced by the API for every alert source; mirrored to Alertmanager in the full profile.
 */
@Entity('alert_silences')
@Index('alert_silences_project', ['projectId'])
export class AlertSilence {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  /** `silence` or `maintenance` (same semantics; maintenance windows are usually scheduled ahead). */
  @Column({ type: 'varchar', length: 20, default: 'silence' })
  kind: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  matchers: SilenceMatcher[];

  @Column({ type: 'timestamp', name: 'starts_at' })
  startsAt: Date;

  @Column({ type: 'timestamp', name: 'ends_at' })
  endsAt: Date;

  @Column({ type: 'text', nullable: true })
  comment: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy: string | null;

  /** Id of the mirrored Alertmanager silence (full profile). */
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'alertmanager_id' })
  alertmanagerId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
