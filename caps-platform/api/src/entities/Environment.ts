import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn
} from 'typeorm';
import { Project } from './Project';

export enum EnvironmentName {
  PREVIEW = 'preview',
  STAGING = 'staging',
  PRODUCTION = 'production',
}

@Entity('environments')
export class Environment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  name: EnvironmentName;

  @Column({ type: 'varchar', length: 100 })
  namespace: string;

  @Column({ type: 'varchar', length: 200 })
  domain: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => Project, (project) => project.environments)
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
