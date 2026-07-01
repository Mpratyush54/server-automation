import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn
} from 'typeorm';

@Entity('service_registrations')
export class ServiceRegistration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'uuid', name: 'environment_id' })
  environmentId: string;

  @Column({ type: 'varchar', length: 200 })
  hostname: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'ip_address' })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 200, name: 'service_name' })
  serviceName: string;

  @Column({ type: 'varchar', length: 100 })
  version: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  branch: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true, name: 'commit_sha' })
  commitSha: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'infisical_project' })
  infisicalProject: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'infisical_env' })
  infisicalEnv: string | null;

  @Column({ type: 'simple-array', name: 'env_keys' })
  envKeys: string[];

  @Column({ type: 'simple-array', name: 'db_types' })
  dbTypes: string[];

  @Column({ type: 'varchar', length: 20, default: 'online' })
  status: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'timestamp', nullable: true, name: 'last_seen' })
  lastSeen: Date | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
