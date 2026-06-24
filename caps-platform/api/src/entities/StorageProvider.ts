import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum StorageProviderType {
  MINIO = 'minio',
  S3 = 's3',
  GOOGLE_DRIVE = 'google_drive',
  LOCAL = 'local',
}

@Entity('storage_providers')
export class StorageProvider {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'enum', enum: StorageProviderType, name: 'provider_type' })
  providerType: StorageProviderType;

  @Column({ type: 'jsonb', nullable: true })
  credentials: Record<string, string> | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'bucket_name' })
  bucketName: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'endpoint_url' })
  endpointUrl: string | null;

  @Column({ type: 'boolean', default: false, name: 'is_default' })
  isDefault: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
