import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

/** Logo + colour branding only (custom themes are out of scope for #46). */
export interface StatusPageBranding {
  logoUrl?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
}

/**
 * Per-project public status page (#46). Components come from #42's status feed
 * (checks with `config.statusPage.visible !== false`); optional `componentIds`
 * further restricts which feed components are shown.
 */
@Entity('status_pages')
@Index('status_pages_project', ['projectId'], { unique: true })
@Index('status_pages_slug', ['slug'], { unique: true })
export class StatusPage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  /** Public URL segment: `/status/:slug`. Lowercase kebab-case. */
  @Column({ type: 'varchar', length: 63 })
  slug: string;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  /** Optional custom hostname for a future dedicated ingress (stored, not required). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  domain: string | null;

  /** When false the public endpoints return 404. */
  @Column({ type: 'boolean', default: false })
  published: boolean;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  branding: StatusPageBranding;

  /**
   * Synthetic check ids to show. `null` = every visible check from the status feed.
   * Empty array = no components.
   */
  @Column({ type: 'jsonb', name: 'component_ids', nullable: true })
  componentIds: string[] | null;

  @Column({ type: 'uuid', name: 'created_by_id', nullable: true })
  createdById: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
