import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index
} from 'typeorm';
import { User } from './User';

@Entity('agent_tokens')
export class AgentToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** Public lookup prefix, e.g. plat_agent_a1b2c3d4 */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, name: 'token_prefix' })
  tokenPrefix: string;

  /** bcrypt hash of the full plat_agent_* secret */
  @Column({ type: 'text', name: 'token_hash' })
  tokenHash: string;

  /** Scopes granted to this token, e.g. commands:validate, commands:execute, projects:read */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  scopes: string[];

  @Column({ type: 'uuid', nullable: true, name: 'created_by_user_id' })
  createdByUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy: User | null;

  @Column({ type: 'timestamp', nullable: true, name: 'last_used_at' })
  lastUsedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'expires_at' })
  expiresAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'revoked_at' })
  revokedAt: Date | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
