import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export interface OncallOverride {
  userId: string;
  startsAt: string;
  endsAt: string;
}

/** Simple rotation (#43): userIds take turns every rotationHours from startsAt; overrides win. */
@Entity('alert_oncall_schedules')
@Index('alert_schedules_project', ['projectId'])
export class AlertOncallSchedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'jsonb', default: () => "'[]'", name: 'user_ids' })
  userIds: string[];

  @Column({ type: 'int', default: 168, name: 'rotation_hours' })
  rotationHours: number;

  @Column({ type: 'timestamp', name: 'starts_at' })
  startsAt: Date;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  overrides: OncallOverride[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
