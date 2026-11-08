import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Operation } from './Operation';

export type OperationStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'compensating'
  | 'compensated'
  | 'skipped';

@Entity('operation_steps')
@Index(['operationId', 'index'], { unique: true })
export class OperationStep {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'operation_id' })
  operationId: string;

  @ManyToOne(() => Operation, (o) => o.steps, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'operation_id' })
  operation: Operation;

  @Column({ type: 'int' })
  index: number;

  @Column({ type: 'varchar', length: 64 })
  name: string;

  @Column({ type: 'varchar', length: 32, default: 'pending' })
  status: OperationStepStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** Non-secret step output shown in the portal (e.g. per-credential rotation results). */
  @Column({ type: 'jsonb', nullable: true })
  output: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'timestamp', nullable: true, name: 'started_at' })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'finished_at' })
  finishedAt: Date | null;
}
