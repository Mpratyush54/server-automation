import {
  Entity, PrimaryGeneratedColumn, Column, OneToMany, CreateDateColumn, UpdateDateColumn
} from 'typeorm';
import { Environment } from './Environment';
import { Deployment } from './Deployment';

export enum StackType {
  NODEJS = 'nodejs',
  ANGULAR = 'angular',
  PYTHON = 'python',
  STATIC = 'static',
}

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  name: string;

  @Column({ type: 'enum', enum: StackType })
  stack: StackType;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true, name: 'repository_url' })
  repositoryUrl: string | null;

  @Column({ type: 'text', nullable: true })
  domain: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'clickup_list_id' })
  clickupListId: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'created_by_id' })
  createdById: string | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ type: 'timestamp', nullable: true, name: 'deleted_at' })
  deletedAt: Date | null;

  @OneToMany(() => Environment, (env) => env.project)
  environments: Environment[];

  @OneToMany(() => Deployment, (dep) => dep.project)
  deployments: Deployment[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
