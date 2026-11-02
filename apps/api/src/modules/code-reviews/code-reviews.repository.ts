import { Injectable } from '@nestjs/common';
import {
  CodeReview,
  CodeReviewDecision,
  CodeReviewEvent,
  CodeReviewReviewer,
  DevelopmentArtifact,
  Prisma,
  WorkItem,
} from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export type ReviewWithRelations = CodeReview & {
  reviewers: CodeReviewReviewer[];
  pullRequest: DevelopmentArtifact | null;
  workItems: Array<{ workItem: WorkItem }>;
};

export interface ReviewFilters {
  projectId: string;
  status?: CodeReview['status'] | undefined;
  reviewerId?: string | undefined;
  authorId?: string | undefined;
  workItemId?: string | undefined;
  pullRequestId?: string | undefined;
  search?: string | undefined;
}

const RELATIONS = {
  reviewers: { orderBy: { createdAt: 'asc' } },
  pullRequest: true,
  workItems: { where: { workItem: { deletedAt: null } }, include: { workItem: true } },
} satisfies Prisma.CodeReviewInclude;

/** Code reviews, their reviewers, work items and history (S5-F3). */
@Injectable()
export class CodeReviewsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  find(id: string, tx?: PrismaTransaction): Promise<ReviewWithRelations | null> {
    return (tx ?? this.prisma).codeReview.findFirst({
      where: this.active({ id }),
      include: RELATIONS,
    });
  }

  /** Locks a live review; every decision on it is serialised by this lock. */
  async lock(id: string, tx: PrismaTransaction): Promise<{ id: string; projectId: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; projectId: string }>>`
      SELECT "id", "projectId" FROM "code_reviews"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
      FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** A live pull request artifact of the project, locked for share. */
  async lockPullRequest(projectId: string, id: string, tx: PrismaTransaction): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "development_artifacts"
      WHERE "id" = ${id} AND "projectId" = ${projectId} AND "kind" = 'pull_request'
        AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
      FOR SHARE`;
    return rows.length === 1;
  }

  /** Live work items of the project, locked in id order. */
  async lockWorkItems(
    projectId: string,
    ids: readonly string[],
    tx: PrismaTransaction,
  ): Promise<Array<{ id: string; key: string }>> {
    if (ids.length === 0) {
      return [];
    }
    return tx.$queryRaw<Array<{ id: string; key: string }>>`
      SELECT "id", "key" FROM "work_items"
      WHERE "id" IN (${Prisma.join([...ids])}) AND "projectId" = ${projectId}
        AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
      ORDER BY "id"
      FOR UPDATE`;
  }

  linkedWorkItems(
    reviewId: string,
    tx: PrismaTransaction,
  ): Promise<Array<{ id: string; key: string }>> {
    return tx.$queryRaw<Array<{ id: string; key: string }>>`
      SELECT w."id", w."key" FROM "work_items" w
      JOIN "code_review_work_items" l ON l."workItemId" = w."id"
      WHERE l."reviewId" = ${reviewId} AND w."organizationId" = ${this.organizationId}
        AND w."deletedAt" IS NULL
      ORDER BY w."id"
      FOR UPDATE OF w`;
  }

  create(
    data: Omit<Prisma.CodeReviewUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<CodeReview> {
    return tx.codeReview.create({ data: { ...data, organizationId: this.organizationId } });
  }

  update(id: string, data: Prisma.CodeReviewUncheckedUpdateInput, tx: PrismaTransaction) {
    return tx.codeReview.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  async addReviewer(projectId: string, reviewId: string, userId: string, tx: PrismaTransaction) {
    const result = await tx.codeReviewReviewer.createMany({
      data: [{ organizationId: this.organizationId, projectId, reviewId, userId }],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  async removeReviewer(reviewId: string, userId: string, tx: PrismaTransaction) {
    const result = await tx.codeReviewReviewer.deleteMany({
      where: this.scope({ reviewId, userId }),
    });
    return result.count === 1;
  }

  reviewers(reviewId: string, tx: PrismaTransaction): Promise<CodeReviewReviewer[]> {
    return tx.codeReviewReviewer.findMany({ where: this.scope({ reviewId }) });
  }

  setDecision(
    id: string,
    decision: CodeReviewDecision,
    comment: string | null,
    tx: PrismaTransaction,
  ) {
    return tx.codeReviewReviewer.update({
      where: { id },
      data: { decision, comment, decidedAt: decision === 'pending' ? null : new Date() },
    });
  }

  async link(
    projectId: string,
    reviewId: string,
    workItemId: string,
    userId: string | null,
    tx: PrismaTransaction,
  ) {
    const result = await tx.codeReviewWorkItem.createMany({
      data: [
        {
          organizationId: this.organizationId,
          projectId,
          reviewId,
          workItemId,
          createdById: userId,
        },
      ],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  async unlink(reviewId: string, workItemId: string, tx: PrismaTransaction) {
    const result = await tx.codeReviewWorkItem.deleteMany({
      where: this.scope({ reviewId, workItemId }),
    });
    return result.count === 1;
  }

  event(
    projectId: string,
    reviewId: string,
    data: {
      kind: string;
      actorId: string | null;
      subjectId?: string | null;
      comment?: string | null;
    },
    tx: PrismaTransaction,
  ) {
    return tx.codeReviewEvent.createMany({
      data: [
        {
          organizationId: this.organizationId,
          projectId,
          reviewId,
          kind: data.kind,
          actorId: data.actorId,
          subjectId: data.subjectId ?? null,
          comment: data.comment ?? null,
        },
      ],
    });
  }

  events(reviewId: string): Promise<CodeReviewEvent[]> {
    return this.prisma.codeReviewEvent.findMany({
      where: this.scope({ reviewId }),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async list(
    query: PaginationQuery,
    filters: ReviewFilters,
  ): Promise<Paginated<ReviewWithRelations>> {
    const where: Prisma.CodeReviewWhereInput = this.active({
      projectId: filters.projectId,
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.authorId === undefined ? {} : { authorId: filters.authorId }),
      ...(filters.pullRequestId === undefined ? {} : { pullRequestId: filters.pullRequestId }),
      ...(filters.reviewerId === undefined
        ? {}
        : { reviewers: { some: { userId: filters.reviewerId } } }),
      ...(filters.workItemId === undefined
        ? {}
        : { workItems: { some: { workItemId: filters.workItemId } } }),
      ...(filters.search === undefined
        ? {}
        : { title: { contains: filters.search, mode: 'insensitive' as const } }),
    });
    const [rows, total] = await Promise.all([
      this.prisma.codeReview.findMany({
        where,
        include: RELATIONS,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.codeReview.count({ where }),
    ]);
    return { data: rows, meta: buildPaginationMeta(query, total) };
  }

  setting(projectId: string) {
    return this.prisma.codeReviewSetting.findFirst({ where: this.scope({ projectId }) });
  }

  async upsertSetting(
    projectId: string,
    requiredApprovals: number,
    userId: string,
    tx: PrismaTransaction,
  ) {
    await tx.codeReviewSetting.upsert({
      where: { projectId },
      create: {
        organizationId: this.organizationId,
        projectId,
        requiredApprovals,
        updatedById: userId,
      },
      update: { requiredApprovals, updatedById: userId },
    });
  }

  members(userIds: readonly string[]) {
    return this.prisma.organizationMember.findMany({
      where: {
        organizationId: this.organizationId,
        userId: { in: [...userIds] },
        status: 'active',
        deletedAt: null,
      },
      select: { userId: true, role: true, user: { select: { fullName: true } } },
    });
  }

  users(userIds: readonly string[]) {
    return this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, fullName: true },
    });
  }
}
