import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

/**
 * A GitHub App installation (#35), kept in sync from `installation` /
 * `installation_repositories` webhooks (and on demand from GET /app/installations).
 * Projects map to an installation through their repository URL (owner/repo).
 */
@Entity('git_app_installations')
export class GitAppInstallation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 50, name: 'installation_id' })
  installationId: string;

  @Column({ type: 'varchar', length: 200, name: 'account_login' })
  accountLogin: string;

  @Column({ type: 'varchar', length: 30, nullable: true, name: 'account_type' })
  accountType: string | null;

  /** 'all' (every repo of the account) or 'selected' (see `repositories`). */
  @Column({ type: 'varchar', length: 20, default: 'selected', name: 'repository_selection' })
  repositorySelection: string;

  /** Lower-cased `owner/repo` names granted to the installation (selected mode). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  repositories: string[];

  @Column({ type: 'timestamp', nullable: true, name: 'suspended_at' })
  suspendedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
