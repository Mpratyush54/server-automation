import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index
} from 'typeorm';
import { User } from './User';

/**
 * TOTP second factor of one user (#24). One row per user.
 *  - `secretEncrypted`: base32 TOTP secret, AES-256-GCM via lib/secrets-encryption.ts.
 *  - `enabledAt`: null while enrolment is pending (secret issued, first code not yet verified).
 *  - `lastUsedStep`: last accepted RFC 6238 time step; codes at or before it are rejected (replay).
 */
@Entity('user_mfa')
export class UserMfa {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'text', name: 'secret_encrypted' })
  secretEncrypted: string;

  @Column({ type: 'timestamp', nullable: true, name: 'enabled_at' })
  enabledAt: Date | null;

  @Column({ type: 'integer', default: 0, name: 'last_used_step' })
  lastUsedStep: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
