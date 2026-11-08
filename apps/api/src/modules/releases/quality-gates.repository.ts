import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

const WITH_RULES = {
  rules: { orderBy: [{ position: 'asc' as const }, { type: 'asc' as const }] },
  environment: { select: { id: true, name: true } },
};

/** Quality gates, their rules and overrides (S6-F3). */
@Injectable()
export class QualityGatesRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  list(projectId: string, environmentId?: string) {
    return this.prisma.qualityGate.findMany({
      where: this.active({
        projectId,
        ...(environmentId === undefined
          ? {}
          : { OR: [{ environmentId }, { environmentId: null }] }),
      }),
      include: WITH_RULES,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  find(id: string) {
    return this.prisma.qualityGate.findFirst({ where: this.active({ id }), include: WITH_RULES });
  }

  /** Enabled gates that apply in the environment (project-wide ones always do). */
  applicable(projectId: string, environmentId: string | null, tx: PrismaTransaction) {
    return tx.qualityGate.findMany({
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
      include: WITH_RULES,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  async lockForUpdate(id: string, tx: PrismaTransaction) {
    await tx.$queryRaw`
      SELECT "id" FROM "quality_gates"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
      FOR UPDATE`;
    return tx.qualityGate.findFirst({ where: this.active({ id }), include: WITH_RULES });
  }

  /** A live environment of the project, locked for share. */
  async lockEnvironment(projectId: string, id: string, tx: PrismaTransaction) {
    const rows = await tx.$queryRaw<Array<{ id: string; name: string; protected: boolean }>>`
      SELECT "id", "name", "protected" FROM "environments"
      WHERE "id" = ${id} AND "projectId" = ${projectId} AND "organizationId" = ${this.organizationId}
        AND "deletedAt" IS NULL
      FOR SHARE`;
    return rows[0] ?? null;
  }

  findEnvironment(projectId: string, id: string, tx: PrismaTransaction) {
    return tx.environment.findFirst({
      where: { organizationId: this.organizationId, projectId, id, deletedAt: null },
      select: { id: true, name: true, protected: true },
    });
  }

  async create(
    data: Omit<Prisma.QualityGateUncheckedCreateInput, 'organizationId' | 'rules'>,
    rules: ReadonlyArray<{ type: string; threshold: number | null }>,
    tx: PrismaTransaction,
  ) {
    const gate = await tx.qualityGate.create({
      data: { ...data, organizationId: this.organizationId },
    });
    await this.replaceRules(gate.id, gate.projectId, rules, tx);
    return gate;
  }

  async replaceRules(
    gateId: string,
    projectId: string,
    rules: ReadonlyArray<{ type: string; threshold: number | null }>,
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.qualityGateRule.deleteMany({ where: { organizationId: this.organizationId, gateId } });
    await tx.qualityGateRule.createMany({
      data: rules.map((rule, position) => ({
        organizationId: this.organizationId,
        projectId,
        gateId,
        type: rule.type,
        threshold: rule.threshold,
        position,
      })),
    });
  }

  update(id: string, data: Prisma.QualityGateUncheckedUpdateInput, tx: PrismaTransaction) {
    return tx.qualityGate.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  latestOverride(releaseId: string, environmentId: string, tx: PrismaTransaction) {
    return tx.qualityGateOverride.findFirst({
      where: { organizationId: this.organizationId, releaseId, environmentId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async createOverride(
    data: Omit<Prisma.QualityGateOverrideUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ) {
    const id = `qgo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    await tx.qualityGateOverride.createMany({
      data: [{ ...data, id, organizationId: this.organizationId }],
    });
    return id;
  }

  user(id: string, tx: PrismaTransaction) {
    return tx.user.findUnique({ where: { id }, select: { id: true, fullName: true } });
  }
}
