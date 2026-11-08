import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type IdempotencyState = 'in_progress' | 'completed';

/**
 * Postgres fallback store for Idempotency-Key replays (Redis is used when available).
 * `id` = sha256(user, route, key); the response body is stored encrypted because
 * some replayed responses carry one-time credentials.
 */
@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id: string;

  @Column({ type: 'varchar', length: 64, name: 'user_id' })
  userId: string;

  @Column({ type: 'varchar', length: 128 })
  route: string;

  @Column({ type: 'varchar', length: 64, name: 'request_hash' })
  requestHash: string;

  @Column({ type: 'varchar', length: 16 })
  state: IdempotencyState;

  @Column({ type: 'int', nullable: true, name: 'response_status' })
  responseStatus: number | null;

  @Column({ type: 'text', nullable: true, name: 'response_body' })
  responseBody: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Index()
  @Column({ type: 'timestamp', name: 'expires_at' })
  expiresAt: Date;
}
