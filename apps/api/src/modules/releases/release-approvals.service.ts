import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import {
  APPROVAL_ACTION_DECISION,
  APPROVAL_TYPE_LABELS,
  ApprovalDecision,
  ApprovalRequirementView,
  ApprovalRuleView,
  ApprovalState,
  ApprovalType,
  CreateApprovalRuleInput,
  DecideApprovalInput,
  ListApprovalRulesQuery,
  ReleaseApprovalsQuery,
  ReleaseApprovalsView,
  RevokeApprovalInput,
  UpdateApprovalRuleInput,
  combineApprovalStates,
  deriveApprovalRequirements,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import {
  ApprovalRequiredError,
  ConflictError,
  DuplicateResourceError,
  ForbiddenError,
  NotFoundError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { QualityGatesRepository } from './quality-gates.repository';
import { ReleaseApprovalsRepository } from './release-approvals.repository';
import { ReleasesRepository } from './releases.repository';

const RULE = 'ReleaseApprovalRule';
type RuleRow = NonNullable<Awaited<ReturnType<ReleaseApprovalsRepository['findRule']>>>;

export interface EnvironmentApprovals {
  state: ApprovalState;
  requirements: ApprovalRequirementView[];
}

/**
 * Release approvals (S6-F4). Rules are configuration, decisions are history;
 * the workflow state is derived from both on every read and inside the
 * deployment transaction of a protected environment.
 */
@Injectable()
export class ReleaseApprovalsService {
  constructor(
    private readonly approvals: ReleaseApprovalsRepository,
    private readonly gates: QualityGatesRepository,
    private readonly releases: ReleasesRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listRules(query: ListApprovalRulesQuery): Promise<ApprovalRuleView[]> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return [];
    }
    return (await this.approvals.listRules(projectId)).map(ruleView);
  }

  async createRule(input: CreateApprovalRuleInput, userId: string): Promise<ApprovalRuleView> {
    const projectId = await this.access.authorizeProjectScope(input.projectId);
    if (projectId === null) {
      throw new NotFoundError('Project');
    }
    const id = await this.uniqueRule(() =>
      this.prisma.runInTransaction(async (tx) => {
        if (
          input.environmentId !== undefined &&
          (await this.gates.lockEnvironment(projectId, input.environmentId, tx)) === null
        ) {
          throw new NotFoundError('Environment');
        }
        const rule = await this.approvals.createRule(
          {
            projectId,
            environmentId: input.environmentId ?? null,
            type: input.type,
            requiredApprovals: input.requiredApprovals,
            allowSelfApproval: input.allowSelfApproval,
            createdById: userId,
          },
          tx,
        );
        await this.record(
          tx,
          AuditAction.create,
          RULE,
          rule.id,
          `Required ${input.type} approval`,
          {
            environmentId: rule.environmentId,
            requiredApprovals: rule.requiredApprovals,
            allowSelfApproval: rule.allowSelfApproval,
          },
        );
        return rule.id;
      }),
    );
    return ruleView(await this.requireRule(id));
  }

  async updateRule(id: string, input: UpdateApprovalRuleInput): Promise<ApprovalRuleView> {
    await this.requireRule(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.approvals.lockRule(id, tx);
      if (current === null) {
        throw new NotFoundError(RULE);
      }
      if (input.version !== undefined && input.version !== current.version) {
        throw new ConflictError(
          'This approval rule was changed by someone else; reload and try again',
          { version: current.version },
        );
      }
      const { version: _version, ...changes } = input;
      await this.approvals.updateRule(
        id,
        {
          ...(changes.requiredApprovals === undefined
            ? {}
            : { requiredApprovals: changes.requiredApprovals }),
          ...(changes.allowSelfApproval === undefined
            ? {}
            : { allowSelfApproval: changes.allowSelfApproval }),
          ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
        },
        tx,
      );
      await this.record(tx, AuditAction.update, RULE, id, `Updated ${current.type} approval rule`, {
        ...changes,
        previous: {
          requiredApprovals: current.requiredApprovals,
          allowSelfApproval: current.allowSelfApproval,
          enabled: current.enabled,
        },
      });
    });
    return ruleView(await this.requireRule(id));
  }

  async removeRule(id: string): Promise<void> {
    await this.requireRule(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.approvals.lockRule(id, tx);
      if (current === null) {
        throw new NotFoundError(RULE);
      }
      await this.approvals.updateRule(id, { deletedAt: new Date() }, tx);
      await this.record(tx, AuditAction.delete, RULE, id, `Deleted ${current.type} approval rule`, {
        type: current.type,
      });
    });
  }

  /** Requirements, derived state and full history of a release's approvals. */
  async view(
    releaseId: string,
    query: ReleaseApprovalsQuery,
    userId: string,
  ): Promise<ReleaseApprovalsView> {
    const release = await this.requireRelease(releaseId);
    const canDecide = await this.access.hasPermission(release.projectId, 'releases.approve');
    return this.prisma.runInTransaction(
      async (tx) => {
        const environment =
          query.environmentId === undefined
            ? null
            : await this.gates.findEnvironment(release.projectId, query.environmentId, tx);
        if (query.environmentId !== undefined && environment === null) {
          throw new NotFoundError('Environment');
        }
        const rows = await this.approvals.decisions(release.id, environment?.id ?? null, tx);
        const evaluated = await this.evaluateWith(
          release.projectId,
          environment?.id ?? null,
          rows,
          tx,
        );
        const users = await this.approvals.users(
          [...new Set(rows.flatMap((row) => [row.approverId, row.revokedById ?? row.approverId]))],
          tx,
        );
        const user = (id: string | null) => users.find((entry) => entry.id === id) ?? null;
        return {
          release: {
            id: release.id,
            name: release.name,
            version: release.version,
            status: release.status,
            createdById: release.createdById,
          },
          environment,
          state: evaluated.state,
          requirements: evaluated.requirements,
          history: rows.map((row) => ({
            id: row.id,
            type: row.type as ApprovalType,
            environment: row.environment,
            decision: row.decision as ApprovalDecision,
            comment: row.comment,
            approver: user(row.approverId),
            createdAt: row.createdAt.toISOString(),
            revokedAt: row.revokedAt?.toISOString() ?? null,
            revokedBy: user(row.revokedById),
            revokeReason: row.revokeReason,
          })),
          actions: {
            decide: canDecide && release.status !== 'archived',
            selfApprovalBlocked:
              release.createdById === userId
                ? evaluated.requirements
                    .filter((requirement) => !requirement.allowSelfApproval)
                    .map((requirement) => requirement.type)
                : [],
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** Approve, reject or request changes; one live decision per approver, type and scope. */
  async decide(
    releaseId: string,
    input: DecideApprovalInput,
    userId: string,
  ): Promise<ReleaseApprovalsView> {
    const release = await this.requireRelease(releaseId);
    await this.access.assertPermission(release.projectId, 'releases.approve');
    const decision = APPROVAL_ACTION_DECISION[input.action];
    try {
      await this.prisma.runInTransaction(async (tx) => {
        const locked = await this.releases.lock(release.id, 'share', tx);
        if (locked === null) {
          throw new NotFoundError('Release');
        }
        if (locked.status === 'archived') {
          throw new ConflictError('An archived release does not take approval decisions');
        }
        const environment =
          input.environmentId === undefined
            ? null
            : await this.gates.lockEnvironment(release.projectId, input.environmentId, tx);
        if (input.environmentId !== undefined && environment === null) {
          throw new NotFoundError('Environment');
        }
        if (decision === 'approved' && release.createdById === userId) {
          const rules = (
            await this.approvals.applicableRules(release.projectId, environment?.id ?? null, tx)
          ).filter((rule) => rule.type === input.type);
          if (rules.length === 0 || rules.some((rule) => !rule.allowSelfApproval)) {
            throw new ForbiddenError(
              `The creator of the release cannot give its ${APPROVAL_TYPE_LABELS[input.type]} approval`,
            );
          }
        }
        const id = await this.approvals.createDecision(
          {
            projectId: release.projectId,
            releaseId: release.id,
            environmentId: environment?.id ?? null,
            type: input.type,
            decision,
            comment: input.comment ?? null,
            approverId: userId,
          },
          tx,
        );
        await this.record(
          tx,
          AuditAction.create,
          'ReleaseApproval',
          id,
          `${decision} (${input.type}) release ${release.version}${environment === null ? '' : ` for ${environment.name}`}`,
          {
            releaseId: release.id,
            environmentId: environment?.id ?? null,
            type: input.type,
            decision,
            comment: input.comment ?? null,
          },
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceError('approval decision', 'approver');
      }
      throw error;
    }
    return this.view(releaseId, pickEnvironment(input.environmentId), userId);
  }

  /** Revokes a live decision: the approver themselves, or anyone with `releases.manage`. */
  async revoke(
    releaseId: string,
    approvalId: string,
    input: RevokeApprovalInput,
    userId: string,
  ): Promise<ReleaseApprovalsView> {
    const release = await this.requireRelease(releaseId);
    let environmentId: string | null = null;
    await this.prisma.runInTransaction(async (tx) => {
      const locked = await this.releases.lock(release.id, 'share', tx);
      const current = await this.approvals.lockDecision(approvalId, tx);
      if (locked === null || current === null || current.releaseId !== release.id) {
        throw new NotFoundError('Approval');
      }
      if (locked.status === 'archived') {
        throw new ConflictError('An archived release does not take approval decisions');
      }
      if (current.revokedAt !== null) {
        throw new ConflictError('This decision was already revoked');
      }
      if (
        current.approverId === userId
          ? !(await this.access.hasPermission(release.projectId, 'releases.approve'))
          : !(await this.access.hasPermission(release.projectId, 'releases.manage'))
      ) {
        throw new ForbiddenError('Only the approver or a release manager can revoke this decision');
      }
      environmentId = current.environmentId;
      await this.approvals.revoke(approvalId, userId, input.reason ?? null, tx);
      await this.record(
        tx,
        AuditAction.update,
        'ReleaseApproval',
        approvalId,
        `Revoked ${current.decision} (${current.type}) of release ${release.version}`,
        { revoked: true, reason: input.reason ?? null, approverId: current.approverId },
      );
    });
    return this.view(releaseId, pickEnvironment(environmentId ?? undefined), userId);
  }

  /** Derived approval workflow of a release in an environment (or release-wide). */
  async forEnvironment(
    projectId: string,
    releaseId: string,
    environmentId: string | null,
    tx: PrismaTransaction,
  ): Promise<EnvironmentApprovals> {
    const rows = await this.approvals.decisions(releaseId, environmentId, tx);
    return this.evaluateWith(projectId, environmentId, rows, tx);
  }

  /** Inside the deployment transaction of a protected environment. */
  async assertApproved(
    projectId: string,
    releaseId: string | null,
    environment: { id: string; name: string },
    tx: PrismaTransaction,
  ): Promise<void> {
    const rules = await this.approvals.applicableRules(projectId, environment.id, tx);
    if (rules.length === 0) {
      return;
    }
    if (releaseId === null) {
      throw new ApprovalRequiredError(
        `Environment ${environment.name} requires release approvals: a deployment there needs a release`,
      );
    }
    const evaluated = await this.forEnvironment(projectId, releaseId, environment.id, tx);
    if (evaluated.state === 'approved') {
      return;
    }
    const missing = evaluated.requirements.filter(
      (requirement) => requirement.state !== 'approved',
    );
    throw new ApprovalRequiredError(
      `Release approvals for ${environment.name} are ${evaluated.state}: ${missing
        .map(
          (requirement) =>
            `${APPROVAL_TYPE_LABELS[requirement.type]} ${requirement.state} (${requirement.approvals}/${requirement.requiredApprovals})`,
        )
        .join('; ')}`,
      { state: evaluated.state, missing },
    );
  }

  private async evaluateWith(
    projectId: string,
    environmentId: string | null,
    rows: Array<{ type: string; decision: string; revokedAt: Date | null }>,
    tx: PrismaTransaction,
  ): Promise<EnvironmentApprovals> {
    const rules = await this.approvals.applicableRules(projectId, environmentId, tx);
    const requirements = deriveApprovalRequirements(
      rules.map((rule) => ({
        type: rule.type as ApprovalType,
        requiredApprovals: rule.requiredApprovals,
        allowSelfApproval: rule.allowSelfApproval,
      })),
      rows
        .filter((row) => row.revokedAt === null)
        .map((row) => ({
          type: row.type as ApprovalType,
          decision: row.decision as ApprovalDecision,
        })),
    );
    return {
      state: combineApprovalStates(requirements.map((requirement) => requirement.state)),
      requirements,
    };
  }

  private async requireRelease(id: string) {
    const release = await this.releases.findById(id);
    if (release === null) {
      throw new NotFoundError('Release');
    }
    await this.access.assertRouteAccess(release.projectId, 'Release');
    return release;
  }

  private async requireRule(id: string): Promise<RuleRow> {
    const row = await this.approvals.findRule(id);
    if (row === null || (await this.access.authorizeProjectScope(row.projectId)) === null) {
      throw new NotFoundError(RULE);
    }
    return row;
  }

  private async uniqueRule<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceError('approval rule', 'type');
      }
      throw error;
    }
  }

  private record(
    tx: PrismaTransaction,
    action: AuditAction,
    entityType: string,
    entityId: string,
    summary: string,
    changes: Record<string, unknown>,
  ) {
    return this.audit.record(
      { action, entityType, entityId, summary, changes: changes as Prisma.InputJsonValue },
      tx,
    );
  }
}

function pickEnvironment(environmentId: string | undefined): ReleaseApprovalsQuery {
  return environmentId === undefined ? {} : { environmentId };
}

function ruleView(row: RuleRow): ApprovalRuleView {
  return {
    id: row.id,
    projectId: row.projectId,
    environment: row.environment,
    type: row.type as ApprovalType,
    requiredApprovals: row.requiredApprovals,
    allowSelfApproval: row.allowSelfApproval,
    enabled: row.enabled,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
