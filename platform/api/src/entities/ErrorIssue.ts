import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, JoinColumn, Check } from 'typeorm';
import { Project } from './Project';
import { User } from './User';

@Entity('error_issues')
@Index('error_issues_group', ['projectId', 'environment', 'fingerprint'], { unique: true })
@Index('error_issues_recent', ['projectId', 'lastSeen'])
@Check('error_issues_status_check', "status IN ('open','resolved','ignored')")
export class ErrorIssue {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'error_issues_pkey' }) id: string;
  @Column({ type: 'uuid', name: 'project_id' }) projectId: string;
  @ManyToOne(() => Project, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'project_id', foreignKeyConstraintName: 'error_issues_project_id_fkey' }) project: Project;
  @Column({ type: 'text' }) environment: string;
  @Column({ type: 'text' }) fingerprint: string;
  @Column({ type: 'jsonb', name: 'fingerprint_aliases', default: () => "'[]'" }) fingerprintAliases: string[];
  @Column({ type: 'text' }) title: string;
  @Column({ type: 'text', default: 'open' }) status: string;
  @Column({ type: 'uuid', nullable: true, name: 'assignee_id' }) assigneeId: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'assignee_id', foreignKeyConstraintName: 'error_issues_assignee_id_fkey' }) assignee: User | null;
  @Column({ type: 'timestamptz', name: 'first_seen', default: () => 'now()' }) firstSeen: Date;
  @Column({ type: 'timestamptz', name: 'last_seen', default: () => 'now()' }) lastSeen: Date;
  @Column({ type: 'bigint', default: 0 }) count: string;
  @Column({ type: 'jsonb', name: 'release_counts', default: () => "'{}'" }) releaseCounts: Record<string, number>;
  @Column({ type: 'text', name: 'latest_release' }) latestRelease: string;
  @Column({ type: 'text', nullable: true, name: 'resolved_release' }) resolvedRelease: string | null;
  @Column({ type: 'boolean', default: false }) regression: boolean;
}
