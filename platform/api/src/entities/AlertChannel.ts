import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export type AlertChannelType = 'slack' | 'pagerduty' | 'teams' | 'discord' | 'webhook' | 'email';

/**
 * A notification channel of one project (#43). Webhook URLs, tokens and signing secrets
 * live only in `secretEnc` (AES-256-GCM, lib/secrets-encryption) and are never returned by
 * the API; `config` holds non-secret settings (Slack channel, e-mail recipients).
 */
@Entity('alert_channels')
@Index('alert_channels_project', ['projectId'])
export class AlertChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  type: AlertChannelType;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  config: Record<string, any>;

  @Column({ type: 'text', nullable: true, name: 'secret_enc' })
  secretEnc: string | null;

  /** Lowest severity delivered to this channel. */
  @Column({ type: 'varchar', length: 20, default: 'info', name: 'min_severity' })
  minSeverity: string;

  /** Admin-only escape hatch: allow private / link-local destinations (SSRF guard). */
  @Column({ type: 'boolean', default: false, name: 'allow_private_network' })
  allowPrivateNetwork: boolean;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'timestamp', nullable: true, name: 'last_delivery_at' })
  lastDeliveryAt: Date | null;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
