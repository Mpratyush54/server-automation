import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn
} from 'typeorm';
import { Project } from './Project';

/**
 * `server`: backend SDKs (Node, Python) — may read project config/secrets and register services.
 * `browser`: frontend SDKs (React, Angular) — the token ships in public JS, so it may only call
 * the ingest endpoints opted in with allowBrowserSdkToken (bug reports, logs, API metrics).
 */
export const SDK_TOKEN_KINDS = ['server', 'browser'] as const;
export type SdkTokenKind = typeof SDK_TOKEN_KINDS[number];

export function isSdkTokenKind(v: unknown): v is SdkTokenKind {
  return typeof v === 'string' && (SDK_TOKEN_KINDS as readonly string[]).includes(v);
}

/**
 * Stored kind -> effective kind. Rows from before the column existed are `server` (the
 * migration default); any unknown value is treated as the least-privileged `browser`.
 */
export function normalizeSdkTokenKind(v: unknown): SdkTokenKind {
  if (v === undefined || v === null || v === '') return 'server';
  return isSdkTokenKind(v) ? v : 'browser';
}

@Entity('sdk_credentials')
export class SdkCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  token: string;

  @Column({ type: 'varchar', length: 50, default: 'active' })
  status: string;

  @Column({ type: 'varchar', length: 20, default: 'server' })
  kind: SdkTokenKind;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
