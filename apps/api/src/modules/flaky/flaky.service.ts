import { Injectable } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import {
  FLAKY_FAILING_TAIL,
  FLAKY_MIN_EXECUTIONS,
  FLAKY_MIN_FLIPS,
  FLAKY_MIN_FLIP_RATE,
  FLAKY_STATUSES,
  FLAKY_WINDOW,
  FlakyDetailQuery,
  FlakyHistoryEntry,
  FlakyMarkRef,
  FlakyMarkState,
  FlakyTestDetailView,
  FlakyTestView,
  ListFlakyTestsQuery,
  MarkFlakyInput,
  Paginated,
  analyzeFlakiness,
  buildPaginationMeta,
  effectiveFlakyStatus,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { FlakyRepository, SampleRow } from './flaky.repository';

type CaseRow = NonNullable<Awaited<ReturnType<FlakyRepository['findCase']>>>;
type MarkRow = Awaited<ReturnType<FlakyRepository['marks']>>[number];

/**
 * Flaky test detection (S7-F6). Nothing derived is stored: each read takes
 * the window of recent results and classifies it with the shared, documented
 * rules, then applies the current manual mark.
 */
@Injectable()
export class FlakyService {
  constructor(
    private readonly flaky: FlakyRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListFlakyTestsQuery): Promise<Paginated<FlakyTestView>> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return { data: [], meta: buildPaginationMeta(query, 0) };
    }
    const samples = await this.flaky.samples(projectId, query.source);
    const byCase = new Map<string, SampleRow[]>();
    for (const sample of samples) {
      byCase.set(sample.testCaseId, [...(byCase.get(sample.testCaseId) ?? []), sample]);
    }
    const ids = [...byCase.keys()];
    const filters = {
      ...(query.suiteId === undefined ? {} : { suiteId: query.suiteId }),
      ...(query.q === undefined ? {} : { q: query.q }),
    };
    const [cases, marks] = await Promise.all([
      this.flaky.cases(projectId, ids, filters),
      this.flaky.currentMarks(projectId, ids),
    ]);
    let rows = cases.map((testCase) =>
      toView(testCase, byCase.get(testCase.id) ?? [], marks.get(testCase.id) ?? null),
    );
    if (query.status !== undefined) {
      rows = rows.filter((row) => row.status === query.status);
    }
    if (query.marked !== undefined) {
      rows = rows.filter(
        (row) => (row.mark !== null && row.mark.state !== 'cleared') === (query.marked === 'true'),
      );
    }
    rows.sort(comparator(query.sort, query.order));
    const start = (query.page - 1) * query.pageSize;
    return {
      data: rows.slice(start, start + query.pageSize),
      meta: buildPaginationMeta(query, rows.length),
    };
  }

  async get(testCaseId: string, query: FlakyDetailQuery): Promise<FlakyTestDetailView> {
    const testCase = await this.requireCase(testCaseId);
    const [samples, marks] = await Promise.all([
      this.flaky.samples(testCase.projectId, query.source, testCase.id),
      this.flaky.marks(testCase.id),
    ]);
    const view = toView(testCase, samples, marks[0] ?? null);
    return {
      ...view,
      rules: {
        window: FLAKY_WINDOW,
        minExecutions: FLAKY_MIN_EXECUTIONS,
        minFlips: FLAKY_MIN_FLIPS,
        minFlipRate: FLAKY_MIN_FLIP_RATE,
        failingTail: FLAKY_FAILING_TAIL,
      },
      history: history(samples),
      marks: marks.map(toMark),
    };
  }

  async mark(
    testCaseId: string,
    input: MarkFlakyInput,
    userId: string,
  ): Promise<FlakyTestDetailView> {
    const testCase = await this.requireCase(testCaseId);
    await this.prisma.runInTransaction(async (tx) => {
      const mark = await this.flaky.addMark(
        {
          projectId: testCase.projectId,
          testCaseId: testCase.id,
          state: input.state,
          reason: input.reason,
          markedById: userId,
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'TestCase',
          entityId: testCase.id,
          summary: `${testCase.key} flaky mark: ${input.state}`,
          changes: { flakyMark: { id: mark.id, state: input.state, reason: input.reason } },
        },
        tx,
      );
    });
    return this.get(testCase.id, { source: 'all' });
  }

  private async requireCase(id: string): Promise<CaseRow> {
    const testCase = await this.flaky.findCase(id);
    if (testCase === null) {
      throw new NotFoundError('Test case');
    }
    await this.access.assertRouteAccess(testCase.projectId, 'Test case');
    return testCase;
  }
}

function toMark(row: MarkRow): FlakyMarkRef {
  return {
    state: row.state as FlakyMarkState,
    reason: row.reason,
    markedBy: row.markedBy,
    markedAt: row.createdAt.toISOString(),
  };
}

function toView(testCase: CaseRow, samples: SampleRow[], mark: MarkRow | null): FlakyTestView {
  const analysis = analyzeFlakiness(samples);
  const current = mark === null ? null : toMark(mark);
  const effective = effectiveFlakyStatus(analysis, current);
  const automated = samples.filter((sample) => sample.automated).length;
  return {
    ...analysis,
    ...effective,
    detectedStatus: analysis.status,
    mark: current,
    automatedExecutions: automated,
    manualExecutions: samples.length - automated,
    testCase: {
      id: testCase.id,
      key: testCase.key,
      title: testCase.title,
      suiteId: testCase.suiteId,
      suiteName: testCase.suite.name,
    },
  };
}

/** Newest first; `flip` marks a result that differs from the previous one. */
function history(samples: SampleRow[]): FlakyHistoryEntry[] {
  const ordered = [...samples].reverse();
  const previous = new Map<string, SampleRow>();
  const entries = ordered.map((sample) => {
    const before = previous.get(sample.iterationKey);
    previous.set(sample.iterationKey, sample);
    return {
      resultId: sample.resultId,
      status: sample.status,
      executedAt: sample.executedAt.toISOString(),
      caseVersion: sample.caseVersion,
      iterationKey: sample.iterationKey,
      iterationLabel: sample.iterationLabel,
      source: sample.automated ? ('automation' as const) : ('manual' as const),
      run: { id: sample.runId, name: sample.runName },
      runCaseId: sample.runCaseId,
      flip:
        before !== undefined &&
        before.caseVersion === sample.caseVersion &&
        before.status !== sample.status,
    };
  });
  return entries.reverse();
}

const RANK = new Map(FLAKY_STATUSES.map((status, index) => [status, index]));

function comparator(sort: ListFlakyTestsQuery['sort'], order: 'asc' | 'desc') {
  const sign = order === 'asc' ? 1 : -1;
  const value = (row: FlakyTestView): number | string => {
    switch (sort) {
      case 'status':
        // Most problematic first when descending.
        return -(RANK.get(row.status) ?? 0);
      case 'flipRate':
        return row.flipRate ?? -1;
      case 'failRate':
        return row.failRate ?? -1;
      case 'executions':
        return row.executions;
      case 'lastExecutedAt':
        return row.lastExecutedAt ?? '';
      case 'key':
        return row.testCase.key;
    }
  };
  return (a: FlakyTestView, b: FlakyTestView): number => {
    const left = value(a);
    const right = value(b);
    if (left !== right) {
      return (left < right ? -1 : 1) * sign;
    }
    return (b.flipRate ?? -1) - (a.flipRate ?? -1) || a.testCase.key.localeCompare(b.testCase.key);
  };
}
