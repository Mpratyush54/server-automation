import {
  Entity, PrimaryGeneratedColumn, Column
} from 'typeorm';

@Entity('clickup_task_links')
export class ClickupTaskLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50, name: 'clickup_task_id' })
  clickupTaskId: string;

  @Column({ type: 'uuid', nullable: true, name: 'deployment_id' })
  deploymentId: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'project_id' })
  projectId: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  branch: string | null;

  @Column({ type: 'text', nullable: true, name: 'preview_url' })
  previewUrl: string | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', name: 'linked_at' })
  linkedAt: Date;
}
