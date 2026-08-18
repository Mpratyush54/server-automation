import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index
} from 'typeorm';
import { User } from './User';
import { AgentToken } from './AgentToken';

export type AgentCommandRiskLevel = 'read' | 'mutating' | 'destructive' | 'denied';
export type AgentCommandApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired';

@Entity('agent_command_approvals')
export class AgentCommandApproval {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  command: string;

  @Column({ type: 'varchar', length: 32, name: 'risk_level' })
  riskLevel: AgentCommandRiskLevel;

  @Index()
  @Column({ type: 'varchar', length: 32, default: 'pending' })
  status: AgentCommandApprovalStatus;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'matched_policy' })
  matchedPolicy: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'requested_by_agent_token_id' })
  requestedByAgentTokenId: string | null;

  @ManyToOne(() => AgentToken, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'requested_by_agent_token_id' })
  requestedByAgentToken: AgentToken | null;

  @Column({ type: 'uuid', nullable: true, name: 'requested_by_user_id' })
  requestedByUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'requested_by_user_id' })
  requestedByUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'approved_by_user_id' })
  approvedByUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'approved_by_user_id' })
  approvedByUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'rejected_by_user_id' })
  rejectedByUserId: string | null;

  @Column({ type: 'timestamp', nullable: true, name: 'approval_expires_at' })
  approvalExpiresAt: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'executed_at' })
  executedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
