import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn
} from 'typeorm';

@Entity('secrets')
export class Secret {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'environment_id' })
  environmentId: string | null;

  @Column({ type: 'varchar', length: 200 })
  key: string;

  @Column({ type: 'text', name: 'encrypted_value' })
  encryptedValue: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'uuid', nullable: true, name: 'created_by_id' })
  createdById: string | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
