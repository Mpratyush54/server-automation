import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

/**
 * Subject consent record for privacy-sensitive telemetry (#47 hooks; #40 replay consumes these).
 * `subjectId` is the app's user.id or an anonymous stable id; `sessionId` scopes a browser session.
 */
@Entity('telemetry_consents')
@Index(['projectId', 'subjectId', 'sessionId'], { unique: true })
export class TelemetryConsent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  /** Application user id or anonymous subject key (max 128). */
  @Column({ type: 'varchar', length: 128, name: 'subject_id' })
  subjectId: string;

  /** Optional browser session id; empty string = subject-wide. */
  @Column({ type: 'varchar', length: 128, name: 'session_id', default: '' })
  sessionId: string;

  @Column({ type: 'boolean', name: 'replay_allowed', default: false })
  replayAllowed: boolean;

  @Column({ type: 'boolean', name: 'analytics_allowed', default: true })
  analyticsAllowed: boolean;

  @Column({ type: 'varchar', length: 32, default: 'sdk' })
  source: 'sdk' | 'portal' | 'api';

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
