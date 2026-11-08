import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

export type BackgroundJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/**
 * Durable record of long-running work (currently: deployment rollouts).
 *
 * The replica that accepts the request claims and runs the job, renewing
 * `lockedUntil` while it works. If that replica dies, the lock lapses and the
 * leader's recovery sweep resumes the job (or fails it after `maxAttempts`),
 * so the target never stays in a non-terminal state.
 */
@Entity('background_jobs')
@Index('idx_background_jobs_status_locked', ['status', 'lockedUntil'])
export class BackgroundJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Job kind, e.g. `deploy`. */
  @Column({ type: 'varchar', length: 64 })
  type: string;

  /** Id of the row the job acts on (deployment id for `deploy`). */
  @Index()
  @Column({ type: 'uuid', name: 'target_id' })
  targetId: string;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status: BackgroundJobStatus;

  /** Last step reached (for operators and resume decisions). */
  @Column({ type: 'varchar', length: 64, default: 'queued' })
  step: string;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 2, name: 'max_attempts' })
  maxAttempts: number;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError: string | null;

  /** Identity (pod name) of the replica currently running the job. */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'locked_by' })
  lockedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'locked_until' })
  lockedUntil: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'finished_at' })
  finishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
