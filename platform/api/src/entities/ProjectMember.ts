import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

export enum ProjectAccessRole {
  OWNER = 'owner',
  DEVOPS = 'devops',
  DEVELOPER = 'developer',
  VIEWER = 'viewer',
}

@Entity('project_members')
@Index(['projectId', 'userId'], { unique: true })
export class ProjectMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ type: 'enum', enum: ProjectAccessRole, default: ProjectAccessRole.VIEWER })
  role: ProjectAccessRole;

  @Column({ type: 'uuid', nullable: true, name: 'granted_by_id' })
  grantedById: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** Higher number = more privilege */
export const PROJECT_ROLE_RANK: Record<ProjectAccessRole, number> = {
  [ProjectAccessRole.VIEWER]: 1,
  [ProjectAccessRole.DEVELOPER]: 2,
  [ProjectAccessRole.DEVOPS]: 3,
  [ProjectAccessRole.OWNER]: 4,
};
