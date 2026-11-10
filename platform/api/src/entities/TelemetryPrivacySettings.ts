import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';
import type { ScrubRule } from '../lib/pii-scrub';

/** Per-type retention in days. Null/omitted → cluster default (TELEMETRY_RETENTION_DAYS / 30). */
export interface TelemetryRetentionDays {
  logs?: number;
  traces?: number;
  profiles?: number;
  replays?: number;
  errors?: number;
}

/** Defaults used when a subject has not recorded consent (#40 session replay). */
export interface PrivacyConsentDefaults {
  /** Session replay recording. Default false (opt-in). */
  replay: boolean;
  /** Product analytics / RUM beyond errors. Default true. */
  analytics: boolean;
}

export const DEFAULT_RETENTION_DAYS: Required<TelemetryRetentionDays> = {
  logs: 30,
  traces: 30,
  profiles: 30,
  replays: 7,
  errors: 90,
};

export const DEFAULT_CONSENT: PrivacyConsentDefaults = {
  replay: false,
  analytics: true,
};

@Entity('telemetry_privacy_settings')
export class TelemetryPrivacySettings {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  /** Extra regex scrubbing rules (applied after built-ins). */
  @Column({ type: 'jsonb', name: 'scrub_rules', default: () => "'[]'" })
  scrubRules: ScrubRule[];

  /** Redact IPv4/IPv6 in API-path telemetry. Collector always redacts IPs. */
  @Column({ type: 'boolean', name: 'scrub_ips', default: true })
  scrubIps: boolean;

  @Column({ type: 'jsonb', name: 'retention_days', default: () => "'{}'" })
  retentionDays: TelemetryRetentionDays;

  @Column({ type: 'jsonb', name: 'consent_defaults', default: () => "'{\"replay\":false,\"analytics\":true}'" })
  consentDefaults: PrivacyConsentDefaults;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by_id' })
  updatedById: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
