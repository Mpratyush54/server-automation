import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn
} from 'typeorm';

/** Singleton row of GitHub/GitLab OAuth apps + CI tokens. Configured after install. */
@Entity('integration_settings')
export class IntegrationSettings {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'github_client_id' })
  githubClientId: string | null;

  @Column({ type: 'text', nullable: true, name: 'github_client_secret' })
  githubClientSecret: string | null;

  @Column({ type: 'text', nullable: true, name: 'github_token' })
  githubToken: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'github_org' })
  githubOrg: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true, name: 'gitlab_url', default: 'https://gitlab.com' })
  gitlabUrl: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'gitlab_client_id' })
  gitlabClientId: string | null;

  @Column({ type: 'text', nullable: true, name: 'gitlab_client_secret' })
  gitlabClientSecret: string | null;

  @Column({ type: 'text', nullable: true, name: 'gitlab_token' })
  gitlabToken: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'gitlab_group' })
  gitlabGroup: string | null;

  @Column({ type: 'text', nullable: true, name: 'clickup_token' })
  clickupToken: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'clickup_list_id' })
  clickupListId: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true, name: 'infisical_url' })
  infisicalUrl: string | null;

  @Column({ type: 'text', nullable: true, name: 'infisical_token' })
  infisicalToken: string | null;

  @Column({ type: 'boolean', default: true, name: 'github_login_enabled' })
  githubLoginEnabled: boolean;

  @Column({ type: 'boolean', default: true, name: 'gitlab_login_enabled' })
  gitlabLoginEnabled: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
