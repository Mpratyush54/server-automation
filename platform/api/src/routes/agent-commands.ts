import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../config/database';
import { AgentCommandApproval } from '../entities/AgentCommandApproval';
import { validateCommand } from '../lib/command-guard';
import { executeValidatedCommand } from '../lib/command-exec';
import {
  AuthenticatedRequest,
  expressAuthenticate,
  requireAgentScope,
  requireHumanJwt,
  logAudit,
  expressRequireRole,
} from '../middleware/auth';
import { UserRole } from '../entities/User';

const router = Router();
const APPROVAL_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Roles allowed to execute guarded commands or approve/reject them as a human. */
const COMMAND_OPERATOR_ROLES = [UserRole.ADMIN, UserRole.DEVOPS];
/** Roles allowed to validate commands (and thereby open approval requests) as a human. */
const COMMAND_VALIDATOR_ROLES = [UserRole.ADMIN, UserRole.DEVOPS, UserRole.TECH_LEAD];

/**
 * Human JWTs bypass agent scope checks in requireAgentScope, so gate them by role here.
 * Agent tokens pass through (their scopes were already checked).
 */
function requireHumanRoleIfHuman(roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.agentToken) return next();
    if (!authReq.user) {
      return res.status(401).json({ error: 'Unauthorized: Agent token or human JWT required' });
    }
    if (!roles.includes(authReq.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient role for agent commands', requiredAnyOf: roles });
    }
    return next();
  };
}

/** An approval may only be used by the same agent token (or human) that requested it. */
function approvalBelongsTo(approval: AgentCommandApproval, authReq: AuthenticatedRequest): boolean {
  if (authReq.agentToken) {
    return approval.requestedByAgentTokenId === authReq.agentToken.id;
  }
  return !approval.requestedByAgentTokenId && !!authReq.user && approval.requestedByUserId === authReq.user.id;
}

function requesterWhere(authReq: AuthenticatedRequest) {
  return authReq.agentToken
    ? { requestedByAgentTokenId: authReq.agentToken.id }
    : { requestedByUserId: authReq.user?.id || '' };
}

function actorMeta(authReq: AuthenticatedRequest) {
  return {
    agentTokenId: authReq.agentToken?.id || null,
    userId: authReq.user?.id || null,
  };
}

/** POST /api/agent/commands/validate */
router.post(
  '/agent/commands/validate',
  expressAuthenticate,
  requireAgentScope('commands:validate'),
  requireHumanRoleIfHuman(COMMAND_VALIDATOR_ROLES),
  async (req: Request, res: Response) => {
    const { command } = req.body || {};
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'command is required' });
    }

    const validation = validateCommand(command);
    const authReq = req as AuthenticatedRequest;

    // For destructive commands, create or reuse a pending approval
    let approvalId: string | null = null;
    if (validation.allowed && validation.requiresHumanApproval) {
      try {
        const ds = await getDb();
        const repo = ds.getRepository(AgentCommandApproval);
        const existing = await repo.findOne({
          where: {
            command: validation.normalizedCommand,
            status: 'pending',
            ...requesterWhere(authReq),
          },
          order: { createdAt: 'DESC' },
        });

        if (existing) {
          approvalId = existing.id;
        } else {
          const created = await repo.save(
            repo.create({
              command: validation.normalizedCommand,
              riskLevel: validation.riskLevel,
              status: 'pending',
              reason: null,
              matchedPolicy: validation.matchedPolicy,
              requestedByAgentTokenId: authReq.agentToken?.id || null,
              requestedByUserId: authReq.user?.id || null,
              approvedByUserId: null,
              rejectedByUserId: null,
              approvalExpiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
              executedAt: null,
              result: null,
              metadata: { source: 'validate' },
            }),
          );
          approvalId = created.id;
        }
      } catch (err: any) {
        return res.status(500).json({ error: err.message || 'Failed to create approval' });
      }
    }

    return res.json({
      ...validation,
      approvalId,
      actor: actorMeta(authReq),
    });
  },
);

/** POST /api/agent/commands/execute */
router.post(
  '/agent/commands/execute',
  expressAuthenticate,
  requireAgentScope('commands:execute'),
  requireHumanRoleIfHuman(COMMAND_OPERATOR_ROLES),
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { command, confirm, reason, approvalId } = req.body || {};

      if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'command is required' });
      }

      const validation = validateCommand(command);
      if (!validation.allowed) {
        return res.status(403).json({ error: validation.message, validation });
      }

      if (validation.requiresConfirm && confirm !== true) {
        return res.status(400).json({
          error: 'confirm=true is required to execute this command',
          validation,
        });
      }

      if (validation.requiresReason && (!reason || typeof reason !== 'string' || !reason.trim())) {
        return res.status(400).json({
          error: 'reason is required for mutating/destructive commands',
          validation,
        });
      }

      const ds = await getDb();
      const approvalRepo = ds.getRepository(AgentCommandApproval);
      let approval: AgentCommandApproval | null = null;

      if (validation.requiresHumanApproval) {
        if (!approvalId || typeof approvalId !== 'string') {
          return res.status(403).json({
            error: 'Destructive commands require a human-approved approvalId',
            validation,
          });
        }

        approval = await approvalRepo.findOne({ where: { id: approvalId } });
        if (!approval) {
          return res.status(404).json({ error: 'Approval not found' });
        }
        if (approval.status !== 'approved') {
          return res.status(403).json({
            error: `Approval status is ${approval.status}; expected approved`,
            approvalId: approval.id,
            status: approval.status,
          });
        }
        if (approval.command !== validation.normalizedCommand) {
          return res.status(400).json({
            error: 'approvalId command does not match the execute command',
          });
        }
        if (!approvalBelongsTo(approval, authReq)) {
          return res.status(403).json({
            error: 'approvalId was requested by a different agent token or user',
          });
        }
        if (approval.approvalExpiresAt && approval.approvalExpiresAt.getTime() < Date.now()) {
          await approvalRepo.update({ id: approval.id, status: 'approved' }, { status: 'expired' });
          return res.status(403).json({ error: 'Approval has expired' });
        }

        // Atomically claim the approval (approved -> executed) so concurrent requests execute it once.
        const claimedAt = new Date();
        const claim = await approvalRepo.update(
          { id: approval.id, status: 'approved' },
          {
            status: 'executed',
            executedAt: claimedAt,
            reason: typeof reason === 'string' ? reason : approval.reason,
          },
        );
        if (!claim || claim.affected !== 1) {
          return res.status(409).json({ error: 'Approval was already used or changed state', approvalId: approval.id });
        }
        approval.status = 'executed';
        approval.executedAt = claimedAt;
      }

      const dryRun = process.env.NODE_ENV === 'test' || process.env.AGENT_COMMAND_DRY_RUN === '1';
      const result = await executeValidatedCommand(validation.normalizedCommand, { dryRun });

      if (approval) {
        await approvalRepo.update({ id: approval.id }, { result: result as any });
      } else if (validation.riskLevel !== 'read') {
        await approvalRepo.save(
          approvalRepo.create({
            command: validation.normalizedCommand,
            riskLevel: validation.riskLevel,
            status: 'executed',
            reason: typeof reason === 'string' ? reason : null,
            matchedPolicy: validation.matchedPolicy,
            requestedByAgentTokenId: authReq.agentToken?.id || null,
            requestedByUserId: authReq.user?.id || null,
            approvedByUserId: null,
            rejectedByUserId: null,
            approvalExpiresAt: null,
            executedAt: new Date(),
            result: result as any,
            metadata: { source: 'execute' },
          }),
        );
      }

      await logAudit({
        userId: authReq.user?.id,
        action: 'agent_command.execute',
        targetType: 'agent_command',
        targetId: approval?.id,
        metadata: {
          command: validation.normalizedCommand,
          riskLevel: validation.riskLevel,
          ok: result.ok,
          agentTokenId: authReq.agentToken?.id,
          dryRun: result.dryRun === true,
        },
        ip: req.ip,
      });

      return res.json({
        validation,
        approvalId: approval?.id || null,
        result,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Command execution failed' });
    }
  },
);

/** GET /api/agent/commands/pending — human JWT only */
router.get(
  '/agent/commands/pending',
  expressAuthenticate,
  requireHumanJwt,
  expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS, UserRole.TECH_LEAD]),
  async (_req: Request, res: Response) => {
    try {
      const ds = await getDb();
      const pending = await ds.getRepository(AgentCommandApproval).find({
        where: { status: 'pending' },
        order: { createdAt: 'DESC' },
      });
      return res.json(pending);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to list pending commands' });
    }
  },
);

/** POST /api/agent/commands/:id/approve — human JWT only */
router.post(
  '/agent/commands/:id/approve',
  expressAuthenticate,
  requireHumanJwt,
  expressRequireRole(COMMAND_OPERATOR_ROLES),
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const ds = await getDb();
      const repo = ds.getRepository(AgentCommandApproval);
      const approval = await repo.findOne({ where: { id: req.params.id } });
      if (!approval) return res.status(404).json({ error: 'Approval not found' });
      if (approval.status !== 'pending') {
        return res.status(409).json({ error: `Cannot approve approval in status ${approval.status}` });
      }

      // Conditional update: only one approver can move pending -> approved.
      const claim = await repo.update(
        { id: approval.id, status: 'pending' },
        {
          status: 'approved',
          approvedByUserId: authReq.user!.id,
          approvalExpiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        },
      );
      if (!claim || claim.affected !== 1) {
        return res.status(409).json({ error: 'Approval changed state concurrently' });
      }
      const saved = (await repo.findOne({ where: { id: approval.id } }))!;

      await logAudit({
        userId: authReq.user!.id,
        action: 'agent_command.approve',
        targetType: 'agent_command',
        targetId: saved.id,
        metadata: { command: saved.command },
        ip: req.ip,
      });

      return res.json(saved);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to approve command' });
    }
  },
);

/** POST /api/agent/commands/:id/reject — human JWT only */
router.post(
  '/agent/commands/:id/reject',
  expressAuthenticate,
  requireHumanJwt,
  expressRequireRole(COMMAND_OPERATOR_ROLES),
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const ds = await getDb();
      const repo = ds.getRepository(AgentCommandApproval);
      const approval = await repo.findOne({ where: { id: req.params.id } });
      if (!approval) return res.status(404).json({ error: 'Approval not found' });
      if (approval.status !== 'pending') {
        return res.status(409).json({ error: `Cannot reject approval in status ${approval.status}` });
      }

      const claim = await repo.update(
        { id: approval.id, status: 'pending' },
        {
          status: 'rejected',
          rejectedByUserId: authReq.user!.id,
          ...(typeof req.body?.reason === 'string' ? { reason: req.body.reason } : {}),
        },
      );
      if (!claim || claim.affected !== 1) {
        return res.status(409).json({ error: 'Approval changed state concurrently' });
      }
      const saved = (await repo.findOne({ where: { id: approval.id } }))!;

      await logAudit({
        userId: authReq.user!.id,
        action: 'agent_command.reject',
        targetType: 'agent_command',
        targetId: saved.id,
        metadata: { command: saved.command },
        ip: req.ip,
      });

      return res.json(saved);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to reject command' });
    }
  },
);

export default router;
