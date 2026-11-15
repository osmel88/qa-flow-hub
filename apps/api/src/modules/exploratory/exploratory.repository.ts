import { Injectable } from '@nestjs/common';
import { DefectSeverity, Prisma } from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export const SESSION_INCLUDE = {
  owner: { select: { id: true, fullName: true } },
  environment: { select: { id: true, name: true } },
  release: { select: { id: true, name: true, version: true } },
  testPlan: { select: { id: true, name: true } },
  testCycle: { select: { id: true, name: true } },
  _count: { select: { findings: true } },
} satisfies Prisma.ExploratorySessionInclude;

export type SessionRow = Prisma.ExploratorySessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

const DEFECT_REF = { select: { id: true, key: true, title: true, severity: true, status: true } };

/** Exploratory sessions (S7-F5): sessions, timeline, findings and links. */
@Injectable()
export class ExploratoryRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  async list(
    query: PaginationQuery,
    filters: Omit<Prisma.ExploratorySessionWhereInput, 'organizationId'>,
  ): Promise<Paginated<SessionRow>> {
    const where = this.scope(filters);
    const [rows, total] = await Promise.all([
      this.prisma.exploratorySession.findMany({
        where,
        include: SESSION_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...this.page(query),
      }),
      this.prisma.exploratorySession.count({ where }),
    ]);
    return { data: rows, meta: buildPaginationMeta(query, total) };
  }

  findById(id: string, tx?: PrismaTransaction): Promise<SessionRow | null> {
    return (tx ?? this.prisma).exploratorySession.findFirst({
      where: this.scope({ id }),
      include: SESSION_INCLUDE,
    });
  }

  async lock(id: string, tx: PrismaTransaction) {
    await tx.$queryRaw`
      SELECT "id" FROM "exploratory_sessions"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
      FOR UPDATE`;
    return tx.exploratorySession.findFirst({ where: this.scope({ id }) });
  }

  async lockFinding(sessionId: string, id: string, tx: PrismaTransaction) {
    await tx.$queryRaw`
      SELECT "id" FROM "exploratory_findings"
      WHERE "id" = ${id} AND "sessionId" = ${sessionId} AND "organizationId" = ${this.organizationId}
      FOR UPDATE`;
    return tx.exploratoryFinding.findFirst({ where: this.scope({ id, sessionId }) });
  }

  create(
    data: Omit<Prisma.ExploratorySessionUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ) {
    return tx.exploratorySession.create({ data: { ...data, organizationId: this.organizationId } });
  }

  async update(
    id: string,
    data: Prisma.ExploratorySessionUncheckedUpdateInput,
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.exploratorySession.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
  }

  event(
    session: { id: string; projectId: string },
    data: { type: string; body?: string | null; findingId?: string | null; actorId: string | null },
    tx: PrismaTransaction,
  ) {
    return tx.exploratorySessionEvent.create({
      data: {
        organizationId: this.organizationId,
        projectId: session.projectId,
        sessionId: session.id,
        type: data.type,
        body: data.body ?? null,
        findingId: data.findingId ?? null,
        actorId: data.actorId,
      },
    });
  }

  createFinding(
    session: { id: string; projectId: string },
    data: {
      title: string;
      description: string | null;
      kind: string;
      severity: DefectSeverity;
      createdById: string;
    },
    tx: PrismaTransaction,
  ) {
    return tx.exploratoryFinding.create({
      data: {
        ...data,
        organizationId: this.organizationId,
        projectId: session.projectId,
        sessionId: session.id,
      },
    });
  }

  linkFindingDefect(id: string, defectId: string, created: boolean, tx: PrismaTransaction) {
    return tx.exploratoryFinding.update({
      where: { id },
      data: { defectId, defectCreated: created },
    });
  }

  findings(sessionId: string) {
    return this.prisma.exploratoryFinding.findMany({
      where: this.scope({ sessionId }),
      include: { defect: DEFECT_REF },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  timeline(sessionId: string) {
    return this.prisma.exploratorySessionEvent.findMany({
      where: this.scope({ sessionId }),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  workItems(sessionId: string) {
    return this.prisma.exploratorySessionWorkItem.findMany({
      where: this.scope({ sessionId }),
      include: { workItem: { select: { id: true, key: true, title: true, status: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  sessionDefects(sessionId: string) {
    return this.prisma.exploratorySessionDefect.findMany({
      where: this.scope({ sessionId }),
      include: { defect: DEFECT_REF },
      orderBy: { createdAt: 'asc' },
    });
  }

  users(ids: readonly string[]) {
    return ids.length === 0
      ? Promise.resolve([])
      : this.prisma.user.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, fullName: true },
        });
  }

  findDefect(projectId: string, id: string, tx: PrismaTransaction) {
    return tx.defect.findFirst({ where: this.active({ projectId, id }) });
  }

  findWorkItem(projectId: string, id: string, tx: PrismaTransaction) {
    return tx.workItem.findFirst({ where: this.active({ projectId, id }) });
  }

  findEnvironment(projectId: string, id: string, tx: PrismaTransaction) {
    return tx.environment.findFirst({ where: this.active({ projectId, id }) });
  }

  findRelease(projectId: string, id: string, tx: PrismaTransaction) {
    return tx.release.findFirst({ where: this.scope({ projectId, id }) });
  }

  findPlan(projectId: string, id: string, tx: PrismaTransaction) {
    return tx.testPlan.findFirst({ where: this.scope({ projectId, id }) });
  }

  findCycle(projectId: string, id: string, tx: PrismaTransaction) {
    return tx.testCycle.findFirst({ where: this.scope({ projectId, id }) });
  }

  findMember(userId: string, tx: PrismaTransaction) {
    return tx.organizationMember.findFirst({
      where: this.active({ userId, status: 'active' as const }),
      select: { userId: true, role: true },
    });
  }

  linkWorkItem(
    session: { id: string; projectId: string },
    workItemId: string,
    tx: PrismaTransaction,
  ) {
    return tx.exploratorySessionWorkItem.create({
      data: {
        sessionId: session.id,
        projectId: session.projectId,
        organizationId: this.organizationId,
        workItemId,
      },
    });
  }

  unlinkWorkItem(sessionId: string, workItemId: string, tx: PrismaTransaction) {
    return tx.exploratorySessionWorkItem.deleteMany({
      where: this.scope({ sessionId, workItemId }),
    });
  }

  linkDefect(session: { id: string; projectId: string }, defectId: string, tx: PrismaTransaction) {
    return tx.exploratorySessionDefect.create({
      data: {
        sessionId: session.id,
        projectId: session.projectId,
        organizationId: this.organizationId,
        defectId,
      },
    });
  }

  unlinkDefect(sessionId: string, defectId: string, tx: PrismaTransaction) {
    return tx.exploratorySessionDefect.deleteMany({ where: this.scope({ sessionId, defectId }) });
  }
}
