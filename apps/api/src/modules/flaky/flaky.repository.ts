import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FLAKY_WINDOW, FlakySource } from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface SampleRow {
  resultId: string;
  status: 'passed' | 'failed';
  executedAt: Date;
  caseVersion: number | null;
  runCaseId: string;
  testCaseId: string;
  iterationKey: string;
  iterationLabel: string | null;
  runId: string;
  runName: string;
  automated: boolean;
}

const CASE_SELECT = {
  id: true,
  key: true,
  title: true,
  projectId: true,
  suiteId: true,
  suite: { select: { name: true } },
} satisfies Prisma.TestCaseSelect;

const MARK_INCLUDE = {
  markedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.TestCaseFlakyMarkInclude;

/** Reads for flaky detection (S7-F6) and the append-only manual marks. */
@Injectable()
export class FlakyRepository extends TenantAwareRepository {
  constructor(
    private readonly db: PrismaService,
    tenant: TenantContextService,
  ) {
    super(db, tenant);
  }

  findCase(id: string) {
    return this.prisma.testCase.findFirst({
      where: this.scope({ id, deletedAt: null }),
      select: CASE_SELECT,
    });
  }

  cases(projectId: string, ids: string[], filters: { suiteId?: string; q?: string }) {
    return this.prisma.testCase.findMany({
      where: this.scope({
        projectId,
        id: { in: ids },
        deletedAt: null,
        ...(filters.suiteId === undefined ? {} : { suiteId: filters.suiteId }),
        ...(filters.q === undefined || filters.q === ''
          ? {}
          : {
              OR: [
                { key: { contains: filters.q, mode: 'insensitive' as const } },
                { title: { contains: filters.q, mode: 'insensitive' as const } },
              ],
            }),
      }),
      select: CASE_SELECT,
    });
  }

  /**
   * The newest {@link FLAKY_WINDOW} `passed`/`failed` results of each case of
   * the project, from runs that are not deleted. A run is automated when an
   * ingestion report created it.
   */
  samples(projectId: string, source: FlakySource, testCaseId?: string): Promise<SampleRow[]> {
    const automated = Prisma.sql`EXISTS (SELECT 1 FROM "ingestion_reports" ir WHERE ir."testRunId" = tr."id")`;
    const sourceSql =
      source === 'manual'
        ? Prisma.sql`AND NOT ${automated}`
        : source === 'automation'
          ? Prisma.sql`AND ${automated}`
          : Prisma.empty;
    const caseSql =
      testCaseId === undefined ? Prisma.empty : Prisma.sql`AND rc."testCaseId" = ${testCaseId}`;
    return this.db.runInTransaction(
      (tx) => tx.$queryRaw<SampleRow[]>`
        SELECT w."resultId", w."status", w."executedAt", w."caseVersion", w."runCaseId",
               w."testCaseId", w."iterationKey", w."iterationLabel", w."runId", w."runName",
               w."automated"
        FROM (
          SELECT r."id" AS "resultId", r."status"::text AS "status", r."executedAt",
                 COALESCE(r."caseVersion", rc."caseVersion") AS "caseVersion",
                 rc."id" AS "runCaseId", rc."testCaseId", rc."iterationKey", rc."iterationLabel",
                 tr."id" AS "runId", tr."name" AS "runName", ${automated} AS "automated",
                 ROW_NUMBER() OVER (
                   PARTITION BY rc."testCaseId" ORDER BY r."executedAt" DESC, r."id" DESC
                 ) AS "rank"
          FROM "test_results" r
          JOIN "test_run_cases" rc ON rc."id" = r."testRunCaseId"
          JOIN "test_runs" tr ON tr."id" = r."testRunId"
          WHERE r."organizationId" = ${this.organizationId}
            AND tr."projectId" = ${projectId}
            AND tr."deletedAt" IS NULL
            AND r."status" IN ('passed', 'failed')
            ${caseSql}
            ${sourceSql}
        ) w
        WHERE w."rank" <= ${FLAKY_WINDOW}
        ORDER BY w."executedAt" DESC, w."resultId" DESC`,
    );
  }

  /** The newest mark of each case, the current one. */
  async currentMarks(projectId: string, testCaseIds: string[]) {
    const rows = await this.prisma.testCaseFlakyMark.findMany({
      where: this.scope({ projectId, testCaseId: { in: testCaseIds } }),
      include: MARK_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['testCaseId'],
    });
    return new Map(rows.map((row) => [row.testCaseId, row]));
  }

  marks(testCaseId: string) {
    return this.prisma.testCaseFlakyMark.findMany({
      where: this.scope({ testCaseId }),
      include: MARK_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  addMark(
    data: Omit<Prisma.TestCaseFlakyMarkUncheckedCreateInput, 'organizationId'>,
    tx: Prisma.TransactionClient,
  ) {
    return tx.testCaseFlakyMark.create({
      data: { ...data, organizationId: this.organizationId },
      include: MARK_INCLUDE,
    });
  }
}
