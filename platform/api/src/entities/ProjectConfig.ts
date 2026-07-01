import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn
} from 'typeorm';

@Entity('project_configs')
export class ProjectConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true, name: 'project_id' })
  projectId: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'environment_id' })
  environmentId: string | null;

  @Column({ type: 'varchar', length: 200 })
  key: string;

  @Column({ type: 'text' })
  value: string;

  @Column({ type: 'uuid', nullable: true, name: 'changed_by_id' })
  changedById: string | null;

  @Column({ type: 'boolean', default: false, name: 'is_secret' })
  isSecret: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'changed_at' })
  changedAt: Date;
}
