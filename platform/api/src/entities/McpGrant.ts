import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * A person's approval for one AI assistant (OAuth client) to use the remote MCP endpoint on
 * their behalf. The assistant acts with `scopes`, intersected on every request with what the
 * person's current role allows (lib/mcp-scopes.ts), and only on projects the person can see.
 * Revoking the grant (portal, or token revocation of its refresh token) ends access at once.
 * No foreign keys (like the other Phase 4+ tables): lookups check that the user and client still exist.
 */
@Entity('mcp_grants')
@Index('mcp_grants_active_user_client', ['userId', 'clientRef'], { unique: true, where: '"revoked_at" IS NULL' })
@Index('mcp_grants_client', ['clientRef'])
export class McpGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** oauth_clients.id (not the public client_id). */
  @Column({ type: 'uuid', name: 'client_ref' })
  clientRef: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  scopes: string[];

  /** Protected resource (audience) the grant is bound to: https://<domain>/mcp. */
  @Column({ type: 'varchar', length: 500 })
  resource: string;

  @Column({ type: 'timestamp', nullable: true, name: 'last_used_at' })
  lastUsedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'revoked_at' })
  revokedAt: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'revoked_by_user_id' })
  revokedByUserId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
