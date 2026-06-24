import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export enum BackupStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  RESTORING = 'restoring',
}

export enum StorageProviderType {
  MINIO = 'minio',
  S3 = 's3',
  GOOGLE_DRIVE = 'google_drive',
  LOCAL = 'local',
}

@Entity('db_backups')
export class DbBackup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 200, name: 'db_name' })
  dbName: string;

  @Column({ type: 'varchar', length: 50 })
  environment: string;

  @Column({ type: 'enum', enum: StorageProviderType, name: 'provider_type' })
  providerType: StorageProviderType;

  @Column({ type: 'varchar', length: 500, name: 'file_id', nullable: true })
  fileId: string | null;

  @Column({ type: 'bigint', name: 'file_size_bytes', nullable: true })
  fileSizeBytes: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  checksum: string | null;

  @Column({ type: 'enum', enum: BackupStatus, default: BackupStatus.PENDING })
  status: BackupStatus;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage: string | null;

  @Column({ type: 'timestamp', nullable: true, name: 'restored_at' })
  restoredAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
