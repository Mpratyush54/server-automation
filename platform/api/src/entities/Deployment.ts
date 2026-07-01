import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn
} from 'typeorm';
import { Project } from './Project';

export enum DeploymentStatus {
  PENDING = 'pending',
  BUILDING = 'building',
  DEPLOYING = 'deploying',
  DEPLOYED = 'deployed',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
  TERMINATED = 'terminated',
  EXPIRED = 'expired',
}

@Entity('deployments')
export class Deployment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'uuid', nullable: true, name: 'environment_id' })
  environmentId: string | null;

  @Column({ type: 'varchar', length: 100 })
  version: string;

  @Column({ type: 'varchar', length: 200 })
  branch: string;

  @Column({ type: 'varchar', length: 40, name: 'commit_sha' })
  commitSha: string;

  @Column({ type: 'varchar', length: 200, name: 'image_tag' })
  imageTag: string;

  @Column({ type: 'enum', enum: DeploymentStatus })
  status: DeploymentStatus;

  @Column({ type: 'uuid', nullable: true, name: 'deployed_by_id' })
  deployedById: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'clickup_task_id' })
  clickupTaskId: string | null;

  @Column({ type: 'text', nullable: true, name: 'preview_url' })
  previewUrl: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'timestamp', nullable: true, name: 'deployed_at' })
  deployedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'terminated_at' })
  terminatedAt: Date | null;

  @ManyToOne(() => Project, (project) => project.deployments)
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
