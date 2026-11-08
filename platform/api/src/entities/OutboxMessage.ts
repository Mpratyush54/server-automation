import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index,
} from 'typeorm';

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed';

/**
 * Transactional outbox: side effects (notifications, e-mail, ClickUp comments) are written
 * in the same transaction as the operation step that produced them and dispatched only
 * after that step committed. Delivery is at-least-once.
 */
@Entity('outbox_messages')
@Index(['status', 'availableAt'])
export class OutboxMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true, name: 'operation_id' })
  operationId: string | null;

  @Column({ type: 'varchar', length: 64 })
  kind: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamp', name: 'available_at', default: () => 'CURRENT_TIMESTAMP' })
  availableAt: Date;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'sent_at' })
  sentAt: Date | null;
}
