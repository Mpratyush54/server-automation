import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

export type GitAppProvider = 'github' | 'gitlab';

/**
 * Credentials created by the automated connect flows (#35): a GitHub App made through the App
 * Manifest flow, or a GitLab OAuth application created with an admin token. One row per
 * provider. Every secret column holds an `encryptValue()` payload (SECRETS_ENCRYPTION_KEY, or
 * JWT_SECRET when unset, as for project secrets) and is never returned by any endpoint.
 */
@Entity('git_provider_apps')
export class GitProviderApp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 20 })
  provider: GitAppProvider;

  /** GitHub App id, or the GitLab OAuth application's numeric id. */
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'app_id' })
  appId: string | null;

  /** GitHub App slug (install URL https://github.com/apps/<slug>/installations/new). */
  @Column({ type: 'varchar', length: 200, nullable: true })
  slug: string | null;

  /** Account or org that owns the GitHub App; GitLab group path for group-level applications. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  owner: string | null;

  /** github: 'User' | 'Organization'; gitlab: 'instance' | 'group'. */
  @Column({ type: 'varchar', length: 30, nullable: true, name: 'owner_type' })
  ownerType: string | null;

  /** GitLab base URL (self-managed or https://gitlab.com). */
  @Column({ type: 'varchar', length: 300, nullable: true, name: 'base_url' })
  baseUrl: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true, name: 'html_url' })
  htmlUrl: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'client_id' })
  clientId: string | null;

  @Column({ type: 'text', nullable: true, name: 'client_secret_enc' })
  clientSecretEnc: string | null;

  @Column({ type: 'text', nullable: true, name: 'webhook_secret_enc' })
  webhookSecretEnc: string | null;

  /** GitHub App RS256 private key (PEM). */
  @Column({ type: 'text', nullable: true, name: 'private_key_enc' })
  privateKeyEnc: string | null;

  /** GitLab only: the admin's bootstrap token, kept only when the admin opts in (webhooks). */
  @Column({ type: 'text', nullable: true, name: 'api_token_enc' })
  apiTokenEnc: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy: string | null;

  @Column({ type: 'timestamp', nullable: true, name: 'last_checked_at' })
  lastCheckedAt: Date | null;

  @Column({ type: 'boolean', nullable: true, name: 'last_check_ok' })
  lastCheckOk: boolean | null;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
