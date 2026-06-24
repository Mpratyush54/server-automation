import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn
} from 'typeorm';

export enum DbType {
  POSTGRES = 'postgres',
  MONGO = 'mongo',
  REDIS = 'redis',
}

export enum DbConnectionStatus {
  CONNECTED = 'connected',
  DEGRADED = 'degraded',
  DISCONNECTED = 'disconnected',
}

@Entity('db_connections')
export class DbConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true, name: 'registration_id' })
  registrationId: string | null;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'enum', enum: DbType, name: 'db_type' })
  dbType: DbType;

  @Column({ type: 'int', default: 10, name: 'pool_size' })
  poolSize: number;

  @Column({ type: 'int', default: 0, name: 'active_count' })
  activeCount: number;

  @Column({ type: 'int', default: 0, name: 'idle_count' })
  idleCount: number;

  @Column({ type: 'enum', enum: DbConnectionStatus })
  status: DbConnectionStatus;

  @Column({ type: 'timestamp', nullable: true, name: 'last_heartbeat' })
  lastHeartbeat: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  metrics: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
