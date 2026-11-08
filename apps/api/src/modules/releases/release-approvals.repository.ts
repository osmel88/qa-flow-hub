import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

const WITH_ENVIRONMENT = { environment: { select: { id: true, name: true } } };

/** Release approval rules and decisions (S6-F4). */
@Injectable()
export class ReleaseApprovalsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  listRules(projectId: string) {
    return this.prisma.releaseApprovalRule.findMany({
      where: this.active({ projectId }),
      include: WITH_ENVIRONMENT,
      orderBy: [{ environmentId: { sort: 'asc', nulls: 'first' } }, { type: 'asc' }, { id: 'asc' }],
    });
  }

  findRule(id: string) {
    return this.prisma.releaseApprovalRule.findFirst({
      where: this.active({ id }),
      include: WITH_ENVIRONMENT,
    });
  }

  async lockRule(id: string, tx: PrismaTransaction) {
    await tx.$queryRaw`
      SELECT "id" FROM "release_approval_rules"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
      FOR UPDATE`;
    return tx.releaseApprovalRule.findFirst({ where: this.active({ id }) });
  }

  createRule(
    data: Omit<Prisma.ReleaseApprovalRuleUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ) {
    return tx.releaseApprovalRule.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }

  updateRule(
    id: string,
    data: Prisma.ReleaseApprovalRuleUncheckedUpdateInput,
    tx: PrismaTransaction,
  ) {
    return tx.releaseApprovalRule.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  }

  /** Enabled rules that apply in the environment (project-wide ones always do). */
  applicableRules(projectId: string, environmentId: string | null, tx: PrismaTransaction) {
    return tx.releaseApprovalRule.findMany({
      where: {
        organizationId: this.organizationId,
        projectId,
        deletedAt: null,
        enabled: true,
        OR:
          environmentId === null
            ? [{ environmentId: null }]
            : [{ environmentId: null }, { environmentId }],
      },
      orderBy: [{ type: 'asc' }, { id: 'asc' }],
    });
  }

  /** Decisions that count in the environment: release-wide ones and its own. */
  decisions(releaseId: string, environmentId: string | null, tx: PrismaTransaction) {
    return tx.releaseApproval.findMany({
      where: {
        organizationId: this.organizationId,
        releaseId,
        OR:
          environmentId === null
            ? [{ environmentId: null }]
            : [{ environmentId: null }, { environmentId }],
      },
      include: WITH_ENVIRONMENT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async createDecision(
    data: Omit<Prisma.ReleaseApprovalUncheckedCreateInput, 'organizationId' | 'id'>,
    tx: PrismaTransaction,
  ): Promise<string> {
    const id = `rap_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    await tx.releaseApproval.createMany({
      data: [{ ...data, id, organizationId: this.organizationId }],
    });
    return id;
  }

  async lockDecision(id: string, tx: PrismaTransaction) {
    await tx.$queryRaw`
      SELECT "id" FROM "release_approvals"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
      FOR UPDATE`;
    return tx.releaseApproval.findFirst({ where: { id, organizationId: this.organizationId } });
  }

  revoke(id: string, revokedById: string, reason: string | null, tx: PrismaTransaction) {
    return tx.releaseApproval.updateMany({
      where: { id, organizationId: this.organizationId, revokedAt: null },
      data: { revokedAt: new Date(), revokedById, revokeReason: reason },
    });
  }

  users(ids: readonly string[], tx: PrismaTransaction) {
    return tx.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, fullName: true },
    });
  }
}
