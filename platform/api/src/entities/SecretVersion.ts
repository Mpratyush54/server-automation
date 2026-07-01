import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn
} from 'typeorm';

@Entity('secret_versions')
export class SecretVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'secret_id' })
  secretId: string;

  @Column({ type: 'text', name: 'encrypted_value' })
  encryptedValue: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'uuid', nullable: true, name: 'changed_by_id' })
  changedById: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
