import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export type IncidentStatus = 'firing' | 'acknowledged' | 'resolved';

/**
 * One alert occurrence (#43): opened by the first `firing` event of a dedupeKey, updated
 * (not re-notified) by repeats, closed by a `resolved` event or by hand. At most one open
 * incident per (project, dedupeKey).
 */
@Entity('alert_incidents')
@Index('alert_incidents_project', ['projectId'])
@Index('alert_incidents_status', ['status'])
@Index('alert_incidents_resolved_at', ['resolvedAt'])
@Index('alert_incidents_open_key', ['projectId', 'dedupeKey'], { unique: true, where: "status <> 'resolved'" })
export class AlertIncident {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 300, name: 'dedupe_key' })
  dedupeKey: string;

  @Column({ type: 'varchar', length: 30 })
  source: string;

  @Column({ type: 'varchar', length: 20 })
  severity: string;

  @Column({ type: 'varchar', length: 20, default: 'firing' })
  status: IncidentStatus;

  @Column({ type: 'varchar', length: 300 })
  title: string;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  url: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  environment: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  labels: Record<string, string>;

  @Column({ type: 'uuid', nullable: true, name: 'policy_id' })
  policyId: string | null;

  /** Silence that suppressed the notification (null = notified). */
  @Column({ type: 'uuid', nullable: true, name: 'silenced_by' })
  silencedBy: string | null;

  @Column({ type: 'int', default: 0, name: 'escalation_step' })
  escalationStep: number;

  @Column({ type: 'timestamp', nullable: true, name: 'next_escalation_at' })
  nextEscalationAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'notified_at' })
  notifiedAt: Date | null;

  @Column({ type: 'int', default: 1, name: 'event_count' })
  eventCount: number;

  @Column({ type: 'timestamp', name: 'first_seen_at' })
  firstSeenAt: Date;

  @Column({ type: 'timestamp', name: 'last_seen_at' })
  lastSeenAt: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'acknowledged_at' })
  acknowledgedAt: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'acknowledged_by' })
  acknowledgedBy: string | null;

  @Column({ type: 'timestamp', nullable: true, name: 'resolved_at' })
  resolvedAt: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'resolved_by' })
  resolvedBy: string | null;

  /** Title of the resolving event when the source sent a distinct one ("... recovered"). */
  @Column({ type: 'varchar', length: 300, nullable: true, name: 'resolved_title' })
  resolvedTitle: string | null;

  /** Last 50 lifecycle entries: { at, type, detail }. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  timeline: { at: string; type: string; detail?: string }[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
