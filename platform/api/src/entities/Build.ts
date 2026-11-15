import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/** `cancelled`: superseded by a newer push before its Job was admitted. */
export type BuildStatus = 'queued' | 'building' | 'succeeded' | 'failed' | 'cancelled';

@Entity('builds')
/** One queued or running push build per environment and commit; finished builds may repeat. */
@Index('builds_push_commit', ['environmentId', 'commitSha'], { unique: true, where: `triggered_by = 'push' AND status IN ('queued', 'building')` })
export class Build {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'project_id', type: 'uuid' }) projectId: string;
  @Column({ name: 'environment_id', type: 'uuid' }) environmentId: string;
  @Column({ name: 'commit_sha', type: 'varchar', length: 40 }) commitSha: string;
  @Column({ type: 'varchar', length: 200 }) branch: string;
  @Column({ type: 'varchar', length: 20, default: 'queued' }) status: BuildStatus;
  @Column({ name: 'image_tag', type: 'text' }) imageTag: string;
  @Column({ name: 'image_digest', type: 'text', nullable: true }) imageDigest: string | null;
  @Column({ name: 'triggered_by', type: 'text' }) triggeredBy: string;
  @Column({ name: 'started_at', type: 'timestamp', nullable: true }) startedAt: Date | null;
  /** Set once the Job is created: a build whose Job later vanishes is failed, never re-run. */
  @Column({ name: 'job_submitted_at', type: 'timestamp', nullable: true }) jobSubmittedAt: Date | null;
  @Column({ name: 'finished_at', type: 'timestamp', nullable: true }) finishedAt: Date | null;
  @Column({ name: 'log_location', type: 'text', nullable: true }) logLocation: string | null;
  @Column({ type: 'text', default: '' }) logs: string;
  @Column({ type: 'text', nullable: true }) error: string | null;
  @Column({ name: 'deployment_id', type: 'uuid', nullable: true }) deploymentId: string | null;
  @Column({ name: 'pruned_at', type: 'timestamp', nullable: true }) prunedAt: Date | null;
  /** When the commit was confirmed as the branch head; orders builds of the same environment. */
  @Column({ name: 'head_checked_at', type: 'timestamp', nullable: true }) headCheckedAt: Date | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
