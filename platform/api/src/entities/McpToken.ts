import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type McpTokenKind = 'access' | 'refresh';

/**
 * Access and refresh tokens of a remote MCP grant. Only a SHA-256 hash of each token is stored
 * (the tokens are 256-bit random values). Refresh tokens rotate: each one can be used once
 * (`usedAt`); presenting a used one again revokes the whole grant.
 */
@Entity('mcp_tokens')
@Index('mcp_tokens_hash', ['tokenHash'], { unique: true })
@Index('mcp_tokens_grant', ['grantId'])
export class McpToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'grant_id' })
  grantId: string;

  @Column({ type: 'varchar', length: 16 })
  kind: McpTokenKind;

  /** hex SHA-256 of the raw token. */
  @Column({ type: 'varchar', length: 64, name: 'token_hash' })
  tokenHash: string;

  @Column({ type: 'timestamp', name: 'expires_at' })
  expiresAt: Date;

  /** Refresh tokens: when it was exchanged for a new pair. */
  @Column({ type: 'timestamp', nullable: true, name: 'used_at' })
  usedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'revoked_at' })
  revokedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
