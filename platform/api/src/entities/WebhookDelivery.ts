import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index,
} from 'typeorm';

/** One row per processed Git provider webhook delivery; duplicates are skipped. */
@Entity('webhook_deliveries')
@Index(['provider', 'deliveryId'], { unique: true })
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 'github' | 'gitlab' */
  @Column({ type: 'varchar', length: 16 })
  provider: string;

  /** X-GitHub-Delivery, or GitLab Idempotency-Key / X-Gitlab-Event-UUID. */
  @Column({ type: 'varchar', length: 128, name: 'delivery_id' })
  deliveryId: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  event: string | null;

  @Index()
  @CreateDateColumn({ name: 'received_at' })
  receivedAt: Date;
}
