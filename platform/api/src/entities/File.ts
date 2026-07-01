import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn
} from 'typeorm';

export enum FileProvider {
  GOOGLE_DRIVE = 'google-drive',
  S3 = 's3',
  MINIO = 'minio',
  LOCAL = 'local',
}

@Entity('files')
export class File {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'enum', enum: FileProvider })
  provider: FileProvider;

  @Column({ type: 'varchar', length: 200 })
  bucket: string;

  @Column({ type: 'text', name: 'storage_key' })
  storageKey: string;

  @Column({ type: 'varchar', length: 500, name: 'original_name' })
  originalName: string;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'mime_type' })
  mimeType: string | null;

  @Column({ type: 'bigint', nullable: true })
  size: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  category: string | null;

  @Column({ type: 'text', nullable: true, name: 'cdn_url' })
  cdnUrl: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'uploaded_by_id' })
  uploadedById: string | null;

  @Column({ type: 'boolean', default: false, name: 'is_deleted' })
  isDeleted: boolean;

  @Column({ type: 'timestamp', nullable: true, name: 'deleted_at' })
  deletedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
