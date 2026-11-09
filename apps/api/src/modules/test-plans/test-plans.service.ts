import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import {
  AttachPlanRunInput,
  CreateTestPlanInput,
  ListTestPlansQuery,
  Paginated,
  PlanCaseProgress,
  TEST_PLAN_ACTION_TARGET,
  TestPlanAction,
  TestPlanActionInput,
  TestPlanProgressView,
  TestPlanStatus,
  TestPlanView,
  TestResultStatus,
  UpdateTestPlanInput,
  buildPaginationMeta,
  canTransitionTestPlan,
  computePlanProgress,
  isEditableTestPlan,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import {
  ConflictError,
  DuplicateResourceError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { PlanRow, ScopeCase, TestPlansRepository } from './test-plans.repository';

const PLAN = 'Test plan';
export const OPEN_DEFECTS = new Set(['open', 'triaged', 'in_progress', 'reopened']);

/**
 * Test plans (S7-F1). Every write locks the plan row (`FOR UPDATE`) and
 * accepts an optional `version`. Starting freezes the scope into
 * `test_plan_scope_items` (version 1); refreshing an active plan appends a
 * new version, so earlier snapshots stay readable. Progress is derived on
 * read from one REPEATABLE READ snapshot.
 */
@Injectable()
export class TestPlansService {
  constructor(
    private readonly plans: TestPlansRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListTestPlansQuery): Promise<Paginated<TestPlanView>> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return { data: [], meta: buildPaginationMeta(query, 0) };
    }
    const page = await this.plans.list(query, { ...query, projectId });
    return { data: await Promise.all(page.data.map((row) => this.view(row))), meta: page.meta };
  }

  async get(id: string): Promise<TestPlanView> {
    return this.view(await this.requirePlan(id));
  }

  async create(input: CreateTestPlanInput, userId: string): Promise<TestPlanView> {
    const projectId = await this.access.authorizeProjectScope(input.projectId);
    if (projectId === null) {
      throw new NotFoundError('Project');
    }
    const id = await this.unique(() =>
      this.prisma.runInTransaction(async (tx) => {
        await this.assertReferences(projectId, input, tx);
        const ownerId = input.ownerId ?? userId;
        await this.assertOwner(projectId, ownerId, tx);
        const plan = await this.plans.create(
          {
            projectId,
            name: input.name,
            description: input.description ?? null,
            ownerId,
            releaseId: input.releaseId ?? null,
            startDate: toDate(input.startDate),
            endDate: toDate(input.endDate),
            createdById: userId,
          },
          tx,
        );
        await this.plans.replaceLinks(plan, input, tx);
        await this.record(tx, AuditAction.create, plan.id, `Created test plan ${plan.name}`, {
          releaseId: plan.releaseId,
          ownerId,
          environmentIds: input.environmentIds,
          suiteIds: input.suiteIds,
          testCaseIds: input.testCaseIds,
        });
        return plan.id;
      }),
    );
    return this.get(id);
  }

  async update(id: string, input: UpdateTestPlanInput): Promise<TestPlanView> {
    const visible = await this.requirePlan(id);
    await this.unique(() =>
      this.prisma.runInTransaction(async (tx) => {
        const current = await this.lockEditable(id, input.version, tx);
        const scopeChange = input.suiteIds !== undefined || input.testCaseIds !== undefined;
        if (scopeChange && current.frozenAt !== null) {
          throw new ConflictError(
            `The scope of ${current.name} is frozen (version ${current.scopeVersion}); refresh it instead`,
          );
        }
        await this.assertReferences(visible.projectId, input, tx);
        if (input.ownerId !== undefined && input.ownerId !== null) {
          await this.assertOwner(visible.projectId, input.ownerId, tx);
        }
        const startDate =
          input.startDate === undefined ? isoDay(current.startDate) : input.startDate;
        const endDate = input.endDate === undefined ? isoDay(current.endDate) : input.endDate;
        if (startDate !== null && endDate !== null && startDate > endDate) {
          throw new ValidationError('The end date cannot be before the start date');
        }
        await this.plans.update(
          id,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
            ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
            ...(input.startDate === undefined ? {} : { startDate: toDate(input.startDate) }),
            ...(input.endDate === undefined ? {} : { endDate: toDate(input.endDate) }),
          },
          tx,
        );
        await this.plans.replaceLinks(
          { id, projectId: visible.projectId },
          {
            ...(input.environmentIds === undefined ? {} : { environmentIds: input.environmentIds }),
            ...(input.suiteIds === undefined ? {} : { suiteIds: input.suiteIds }),
            ...(input.testCaseIds === undefined ? {} : { testCaseIds: input.testCaseIds }),
          },
          tx,
        );
        const { version: _version, ...changes } = input;
        await this.record(tx, AuditAction.update, id, `Updated test plan ${current.name}`, {
          fields: Object.keys(changes),
          ...changes,
        });
      }),
    );
    return this.get(id);
  }

  async transition(
    id: string,
    action: TestPlanAction,
    input: TestPlanActionInput,
  ): Promise<TestPlanView> {
    const visible = await this.requirePlan(id);
    const target = TEST_PLAN_ACTION_TARGET[action];
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockVersion(id, input.version, tx);
      const from = current.status as TestPlanStatus;
      if (!canTransitionTestPlan(from, target)) {
        throw new InvalidStateTransitionError(PLAN, from, target);
      }
      const now = new Date();
      const data: Prisma.TestPlanUncheckedUpdateInput = { status: target };
      let frozen = 0;
      if (target === 'active') {
        const scope = await this.plans.liveScope(id, visible.projectId, tx);
        if (scope.length === 0) {
          throw new ValidationError('A test plan needs at least one live test case to start');
        }
        await this.plans.writeScope({ id, projectId: visible.projectId }, 1, scope, tx);
        frozen = scope.length;
        Object.assign(data, { scopeVersion: 1, frozenAt: now, startedAt: now });
      } else if (target === 'completed') {
        data.completedAt = now;
      } else if (target === 'archived') {
        data.archivedAt = now;
      }
      await this.plans.update(id, data, tx);
      await this.record(tx, AuditAction.update, id, `Test plan ${current.name}: ${action}`, {
        status: { from, to: target },
        ...(target === 'active' ? { frozenScope: { version: 1, cases: frozen } } : {}),
      });
    });
    return this.get(id);
  }

  /** Appends a new scope version from the plan's current suites and cases. */
  async refreshScope(id: string, input: TestPlanActionInput): Promise<TestPlanView> {
    const visible = await this.requirePlan(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockVersion(id, input.version, tx);
      if (current.status !== 'active') {
        throw new ConflictError('Only an active test plan can refresh its frozen scope');
      }
      const previous = await this.plans.frozenScope(id, current.scopeVersion, tx);
      const scope = await this.plans.liveScope(id, visible.projectId, tx);
      if (scope.length === 0) {
        throw new ValidationError('The refreshed scope would be empty');
      }
      const next = current.scopeVersion + 1;
      await this.plans.writeScope({ id, projectId: visible.projectId }, next, scope, tx);
      await this.plans.update(id, { scopeVersion: next, frozenAt: new Date() }, tx);
      const before = new Set(previous.map((row) => row.testCaseId));
      const after = new Set(scope.map((row) => row.testCaseId));
      await this.record(
        tx,
        AuditAction.update,
        id,
        `Refreshed scope of test plan ${current.name}`,
        {
          scopeVersion: { from: current.scopeVersion, to: next },
          added: scope.filter((row) => !before.has(row.testCaseId)).map((row) => row.key),
          removed: previous.filter((row) => !after.has(row.testCaseId)).map((row) => row.key),
        },
      );
    });
    return this.get(id);
  }

  async attachRun(id: string, input: AttachPlanRunInput): Promise<TestPlanView> {
    const visible = await this.requirePlan(id);
    try {
      await this.prisma.runInTransaction(async (tx) => {
        const current = await this.lockEditable(id, undefined, tx);
        const run = await this.plans.findRun(visible.projectId, input.testRunId, tx);
        if (run === null) {
          throw new NotFoundError('Test run');
        }
        await this.plans.attachRun({ id, projectId: visible.projectId }, run.id, tx);
        await this.record(
          tx,
          AuditAction.update,
          id,
          `Attached run ${run.name} to ${current.name}`,
          {
            testRunId: run.id,
          },
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('This test run already belongs to a test plan');
      }
      throw error;
    }
    return this.get(id);
  }

  async detachRun(id: string, testRunId: string): Promise<TestPlanView> {
    await this.requirePlan(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockEditable(id, undefined, tx);
      if ((await tx.testCycleRun.count({ where: { testRunId } })) > 0) {
        throw new ConflictError('This run belongs to a test cycle; detach it from the cycle first');
      }
      const removed = await this.plans.detachRun(id, testRunId, tx);
      if (removed.count === 0) {
        throw new NotFoundError('Test run in plan');
      }
      await this.record(tx, AuditAction.update, id, `Detached a run from ${current.name}`, {
        testRunId,
      });
    });
    return this.get(id);
  }

  async progress(id: string): Promise<TestPlanProgressView> {
    const visible = await this.requirePlan(id);
    return this.prisma.runInTransaction(
      async (tx) => {
        const plan = await this.plans.findById(id, tx);
        if (plan === null) {
          throw new NotFoundError(PLAN);
        }
        const scope =
          plan.frozenAt === null
            ? await this.plans.liveScope(id, visible.projectId, tx)
            : await this.plans.frozenScope(id, plan.scopeVersion, tx);
        const { runIds, rows } = await this.plans.runCases(id, tx);
        const cases: Array<PlanCaseProgress & { inRun: boolean }> = scope.map((entry) =>
          caseProgress(
            entry,
            rows.filter((row) => row.testCaseId === entry.testCaseId),
          ),
        );
        const defects = await this.plans.defects(
          visible.projectId,
          runIds,
          scope.map((entry) => entry.testCaseId),
          tx,
        );
        return {
          plan: { id: plan.id, name: plan.name, status: plan.status as TestPlanStatus },
          scope: { frozen: plan.frozenAt !== null, version: plan.scopeVersion },
          ...computePlanProgress(cases),
          cases: cases.map(({ inRun: _inRun, ...entry }) => entry),
          defects: {
            open: defects.filter((row) => OPEN_DEFECTS.has(row.status)).length,
            total: defects.length,
            items: defects.slice(0, 50),
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  // --- internals -------------------------------------------------------------

  private async requirePlan(id: string): Promise<PlanRow> {
    const plan = await this.plans.findById(id);
    if (plan === null) {
      throw new NotFoundError(PLAN);
    }
    await this.access.assertRouteAccess(plan.projectId, PLAN);
    return plan;
  }

  private async lockVersion(id: string, version: number | undefined, tx: PrismaTransaction) {
    const current = await this.plans.lock(id, tx);
    if (current === null) {
      throw new NotFoundError(PLAN);
    }
    if (version !== undefined && version !== current.version) {
      throw new ConflictError('This test plan was changed by someone else; reload and try again', {
        version: current.version,
      });
    }
    return current;
  }

  private async lockEditable(id: string, version: number | undefined, tx: PrismaTransaction) {
    const current = await this.lockVersion(id, version, tx);
    if (!isEditableTestPlan(current.status as TestPlanStatus)) {
      throw new ConflictError(
        `Test plan ${current.name} is ${current.status} and can no longer be changed`,
      );
    }
    return current;
  }

  /** Every referenced id must be live and inside the plan's project (404 otherwise). */
  private async assertReferences(
    projectId: string,
    input: {
      releaseId?: string | null | undefined;
      environmentIds?: string[] | undefined;
      suiteIds?: string[] | undefined;
      testCaseIds?: string[] | undefined;
    },
    tx: PrismaTransaction,
  ): Promise<void> {
    if (input.releaseId !== undefined && input.releaseId !== null) {
      const release = await this.plans.findRelease(projectId, input.releaseId, tx);
      if (release === null) {
        throw new NotFoundError('Release');
      }
      if (release.status === 'archived') {
        throw new ConflictError('An archived release cannot be planned');
      }
    }
    const check = async (
      list: string[] | undefined,
      find: (ids: string[]) => Promise<Array<{ id: string }>>,
      resource: string,
    ) => {
      if (list !== undefined && list.length > 0 && (await find(list)).length !== list.length) {
        throw new NotFoundError(resource);
      }
    };
    await check(
      input.environmentIds,
      (ids) => this.plans.liveEnvironments(projectId, ids, tx),
      'Environment',
    );
    await check(input.suiteIds, (ids) => this.plans.liveSuites(projectId, ids, tx), 'Test suite');
    await check(input.testCaseIds, (ids) => this.plans.liveCases(projectId, ids, tx), 'Test case');
  }

  async assertOwner(projectId: string, ownerId: string, tx: PrismaTransaction) {
    const member = await this.plans.findMember(ownerId, tx);
    if (member === null || !(await this.access.memberSees(projectId, ownerId, member.role))) {
      throw new ValidationError('The owner must be an active member who can see this project');
    }
  }

  private async unique<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceError('test plan', 'name');
      }
      throw error;
    }
  }

  private async view(row: PlanRow): Promise<TestPlanView> {
    const caseCount =
      row.frozenAt === null
        ? (
            await this.prisma.runInTransaction((tx) =>
              this.plans.liveScope(row.id, row.projectId, tx),
            )
          ).length
        : await this.plans.countScope(row.id, row.scopeVersion);
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      description: row.description,
      status: row.status as TestPlanStatus,
      owner: row.owner,
      release: row.release,
      environments: row.environments.map((entry) => entry.environment),
      suites: row.suites.map((entry) => entry.suite),
      directCases: row.cases.map((entry) => entry.testCase),
      runs: row.runs.map((entry) => entry.testRun),
      startDate: isoDay(row.startDate),
      endDate: isoDay(row.endDate),
      scope: {
        frozen: row.frozenAt !== null,
        version: row.scopeVersion,
        frozenAt: row.frozenAt?.toISOString() ?? null,
        caseCount,
      },
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      archivedAt: row.archivedAt?.toISOString() ?? null,
    };
  }

  private record(
    tx: PrismaTransaction,
    action: AuditAction,
    entityId: string,
    summary: string,
    changes: Record<string, unknown>,
  ) {
    return this.audit.record(
      {
        action,
        entityType: 'TestPlan',
        entityId,
        summary,
        changes: changes as Prisma.InputJsonValue,
      },
      tx,
    );
  }
}

/** The latest executed result among the plan runs wins; otherwise untested. */
export function caseProgress(
  entry: ScopeCase,
  rows: ReadonlyArray<{
    status: TestResultStatus;
    run: { id: string; name: string };
    executedAt: Date | null;
  }>,
): PlanCaseProgress & { inRun: boolean } {
  const executed = rows
    .filter((row) => row.executedAt !== null && row.status !== 'untested')
    .sort((a, b) => b.executedAt!.getTime() - a.executedAt!.getTime())[0];
  const shown = executed ?? rows[0];
  // A parameterized case has one execution per dataset row in a run; the case
  // counts once, with the worst status of its rows in the newest run.
  const status =
    executed === undefined
      ? 'untested'
      : worstStatus(rows.filter((row) => row.run.id === executed.run.id));
  return {
    testCaseId: entry.testCaseId,
    key: entry.key,
    title: entry.title,
    suite: entry.suiteName,
    source: entry.source,
    status,
    run: shown?.run ?? null,
    executedAt: executed?.executedAt?.toISOString() ?? null,
    inRun: rows.length > 0,
  };
}

const STATUS_WEIGHT: Record<TestResultStatus, number> = {
  failed: 5,
  blocked: 4,
  untested: 3,
  skipped: 2,
  passed: 1,
};

function worstStatus(rows: ReadonlyArray<{ status: TestResultStatus }>): TestResultStatus {
  return rows.reduce<TestResultStatus>(
    (worst, row) => (STATUS_WEIGHT[row.status] > STATUS_WEIGHT[worst] ? row.status : worst),
    'passed',
  );
}

export function toDate(value: string | null | undefined): Date | null {
  return value === undefined || value === null ? null : new Date(`${value}T00:00:00Z`);
}

export function isoDay(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}
