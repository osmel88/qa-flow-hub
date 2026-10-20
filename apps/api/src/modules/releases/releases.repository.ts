import { Injectable } from '@nestjs/common';
import { Prisma, Release, ReleaseStatus, TestResultStatus } from '@prisma/client';
import {
  Paginated,
  PaginationQuery,
  TEST_RESULT_STATUSES,
  buildPaginationMeta,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export type ReleaseWithRunCount = Release & { runCount: number };

export interface ReleaseFilters {
  projectId: string;
  status?: ReleaseStatus;
  search?: string;
}

export type StatusCounts = Record<TestResultStatus, number>;

export interface ReleaseRunCounts {
  id: string;
  name: string;
  status: string;
  environment: string | null;
  createdAt: Date;
  completedAt: Date | null;
  counts: StatusCounts;
}

export interface ReleaseCaseStatus {
  testCaseId: string;
  status: TestResultStatus;
  testRunId: string;
  testRunName: string;
}

export interface ReleaseRequirementCase {
  requirementId: string;
  requirementKey: string;
  requirementTitle: string;
  requirementStatus: string;
  testCaseId: string | null;
  testCaseKey: string | null;
  testCaseTitle: string | null;
}

const RUN_COUNT = { _count: { select: { runs: { where: { deletedAt: null } } } } } as const;

@Injectable()
export class ReleasesRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  async findById(id: string, tx?: PrismaTransaction): Promise<ReleaseWithRunCount | null> {
    const row = await (tx ?? this.prisma).release.findFirst({
      where: this.scope({ id }),
      include: RUN_COUNT,
    });
    return row === null ? null : withRunCount(row);
  }

  findByVersion(
    projectId: string,
    version: string,
    tx?: PrismaTransaction,
  ): Promise<Release | null> {
    return (tx ?? this.prisma).release.findFirst({ where: this.scope({ projectId, version }) });
  }

  async list(
    query: PaginationQuery,
    filters: ReleaseFilters,
  ): Promise<Paginated<ReleaseWithRunCount>> {
    const where: Prisma.ReleaseWhereInput = this.scope({
      projectId: filters.projectId,
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: filters.search, mode: Prisma.QueryMode.insensitive } },
              { version: { contains: filters.search, mode: Prisma.QueryMode.insensitive } },
              { tag: { contains: filters.search, mode: Prisma.QueryMode.insensitive } },
            ],
          }),
    });

    const [rows, total] = await Promise.all([
      this.prisma.release.findMany({
        where,
        include: RUN_COUNT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...this.page(query),
      }),
      this.prisma.release.count({ where }),
    ]);

    return { data: rows.map(withRunCount), meta: buildPaginationMeta(query, total) };
  }

  /** Every release of the project, for selectors; small by nature. */
  listAll(projectId: string): Promise<Release[]> {
    return this.prisma.release.findMany({
      where: this.scope({ projectId }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  create(
    data: Omit<Prisma.ReleaseUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<Release> {
    return tx.release.create({ data: { ...data, organizationId: this.organizationId } });
  }

  async update(id: string, data: Prisma.ReleaseUpdateInput, tx: PrismaTransaction): Promise<void> {
    await tx.release.updateMany({ where: this.scope({ id }), data });
  }

  /**
   * Serialises status changes of one release against each other (`FOR UPDATE`)
   * and against runs being attached to it (`FOR SHARE`): a run can never be
   * attached to a release that is being closed at the same moment.
   */
  async lock(
    id: string,
    mode: 'share' | 'update',
    tx: PrismaTransaction,
  ): Promise<{ id: string; projectId: string; status: ReleaseStatus } | null> {
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<Array<{ id: string; projectId: string; status: ReleaseStatus }>>`
            SELECT "id", "projectId", "status" FROM "releases"
            WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
            FOR UPDATE`
        : await tx.$queryRaw<Array<{ id: string; projectId: string; status: ReleaseStatus }>>`
            SELECT "id", "projectId", "status" FROM "releases"
            WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
            FOR SHARE`;
    return rows[0] ?? null;
  }

  // --- Dashboard -----------------------------------------------------------

  async runCounts(releaseId: string, tx: PrismaTransaction): Promise<ReleaseRunCounts[]> {
    const rows = await tx.$queryRaw<
      Array<
        {
          id: string;
          name: string;
          status: string;
          environment: string | null;
          createdAt: Date;
          completedAt: Date | null;
        } & StatusCounts
      >
    >`
      SELECT r.id, r.name, r.status::text AS status, r.environment, r."createdAt", r."completedAt",
        ${statusColumns()}
      FROM test_runs r
      LEFT JOIN test_run_cases c
        ON c."testRunId" = r.id AND c."organizationId" = ${this.organizationId}
      WHERE r."organizationId" = ${this.organizationId}
        AND r."releaseId" = ${releaseId} AND r."deletedAt" IS NULL
      GROUP BY r.id
      ORDER BY r."createdAt" DESC, r.id DESC`;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      environment: row.environment,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      counts: pickCounts(row),
    }));
  }

  /**
   * One row per case in the release: the most recent result across its
   * non-aborted runs. An executed attempt always beats `untested`, so adding
   * the case to a new run does not hide what the previous run found.
   */
  async caseStatuses(releaseId: string, tx: PrismaTransaction): Promise<ReleaseCaseStatus[]> {
    return tx.$queryRaw<ReleaseCaseStatus[]>`
      SELECT DISTINCT ON (c."testCaseId")
        c."testCaseId", c."latestStatus" AS status, r.id AS "testRunId", r.name AS "testRunName"
      FROM test_run_cases c
      JOIN test_runs r ON r.id = c."testRunId" AND r."organizationId" = ${this.organizationId}
      LEFT JOIN LATERAL (
        SELECT MAX(t."executedAt") AS at FROM test_results t
        WHERE t."testRunCaseId" = c.id AND t."organizationId" = ${this.organizationId}
      ) last ON true
      WHERE c."organizationId" = ${this.organizationId}
        AND r."releaseId" = ${releaseId} AND r."deletedAt" IS NULL AND r.status <> 'aborted'
      ORDER BY c."testCaseId", (c."latestStatus" = 'untested') ASC,
        last.at DESC NULLS LAST, r."createdAt" DESC, r.id DESC`;
  }

  /** requirement × verifying case pairs of the project; requirements without cases once, with nulls. */
  requirementCases(projectId: string, tx: PrismaTransaction): Promise<ReleaseRequirementCase[]> {
    return tx.$queryRaw<ReleaseRequirementCase[]>`
      SELECT q.id AS "requirementId", q.key AS "requirementKey", q.title AS "requirementTitle",
        q.status::text AS "requirementStatus",
        t.id AS "testCaseId", t.key AS "testCaseKey", t.title AS "testCaseTitle"
      FROM requirements q
      LEFT JOIN traceability_links l
        ON l."organizationId" = ${this.organizationId}
        AND l."sourceType" = 'requirement' AND l."sourceId" = q.id AND l."targetType" = 'test_case'
      LEFT JOIN test_cases t
        ON t.id = l."targetId" AND t."organizationId" = ${this.organizationId}
        AND t."projectId" = q."projectId" AND t."deletedAt" IS NULL AND t."archivedAt" IS NULL
      WHERE q."organizationId" = ${this.organizationId} AND q."projectId" = ${projectId}
        AND q."deletedAt" IS NULL AND q.status <> 'obsolete'
        AND (l.id IS NULL OR t.id IS NOT NULL)
      ORDER BY q.key ASC, t.key ASC NULLS LAST`;
  }

  async defectCounts(
    releaseId: string,
    tx: PrismaTransaction,
  ): Promise<{ total: number; open: number }> {
    const rows = await tx.$queryRaw<Array<{ total: number; open: number }>>`
      SELECT COUNT(*)::int AS total,
        (COUNT(*) FILTER (WHERE d.status IN ('open', 'triaged', 'in_progress', 'reopened')))::int AS open
      FROM defects d
      JOIN test_runs r ON r.id = d."testRunId" AND r."organizationId" = ${this.organizationId}
      WHERE d."organizationId" = ${this.organizationId} AND d."deletedAt" IS NULL
        AND r."releaseId" = ${releaseId} AND r."deletedAt" IS NULL`;
    return rows[0] ?? { total: 0, open: 0 };
  }
}

function withRunCount(row: Release & { _count: { runs: number } }): ReleaseWithRunCount {
  const { _count, ...release } = row;
  return { ...release, runCount: _count.runs };
}

function statusColumns(): Prisma.Sql {
  return Prisma.join(
    TEST_RESULT_STATUSES.map(
      (status) =>
        Prisma.sql`(COUNT(c.id) FILTER (WHERE c."latestStatus" = ${Prisma.raw(`'${status}'`)}))::int AS ${Prisma.raw(`"${status}"`)}`,
    ),
    ', ',
  );
}

function pickCounts(row: StatusCounts): StatusCounts {
  return {
    untested: row.untested,
    passed: row.passed,
    failed: row.failed,
    blocked: row.blocked,
    skipped: row.skipped,
  };
}
