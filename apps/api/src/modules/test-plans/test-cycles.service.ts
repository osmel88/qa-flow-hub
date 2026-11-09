import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import {
  AttachCycleRunInput,
  CreateTestCycleInput,
  ListTestCyclesQuery,
  Paginated,
  PlanCaseProgress,
  TEST_CYCLE_ACTION_TARGET,
  TestCycleAction,
  TestCycleActionInput,
  TestCycleProgressView,
  TestCycleStatus,
  TestCycleView,
  UpdateTestCycleInput,
  canTransitionTestCycle,
  computePlanProgress,
  isEditableTestCycle,
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
import { CycleRow, TestCyclesRepository } from './test-cycles.repository';
import { ScopeCase, TestPlansRepository } from './test-plans.repository';
import { OPEN_DEFECTS, TestPlansService, caseProgress, isoDay, toDate } from './test-plans.service';

const CYCLE = 'Test cycle';
const PLAN = 'Test plan';

/**
 * Test cycles (S7-F2). A cycle lives inside a plan. Until it starts its
 * scope is the plan's; starting copies the plan's frozen scope into the
 * cycle's own append-only snapshot, so later plan changes never alter it.
 * Writes lock the cycle (`FOR UPDATE`), then share-lock the plan, and accept
 * an optional `version`. Progress is derived on read in one REPEATABLE READ
 * snapshot from the runs attached to the cycle.
 */
@Injectable()
export class TestCyclesService {
  constructor(
    private readonly cycles: TestCyclesRepository,
    private readonly plans: TestPlansRepository,
    private readonly planService: TestPlansService,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListTestCyclesQuery): Promise<Paginated<TestCycleView>> {
    await this.requirePlan(query.testPlanId);
    const page = await this.cycles.list(query, query);
    return { data: await Promise.all(page.data.map((row) => this.view(row))), meta: page.meta };
  }

  async get(id: string): Promise<TestCycleView> {
    return this.view(await this.requireCycle(id));
  }

  async create(input: CreateTestCycleInput, userId: string): Promise<TestCycleView> {
    const plan = await this.requirePlan(input.testPlanId);
    const id = await this.unique(() =>
      this.prisma.runInTransaction(async (tx) => {
        const locked = await this.cycles.lockPlan(plan.id, tx);
        if (locked === null) {
          throw new NotFoundError(PLAN);
        }
        this.assertPlanOpen(locked);
        const releaseId = input.releaseId === undefined ? locked.releaseId : input.releaseId;
        await this.assertTarget(plan.projectId, plan.id, input.environmentId, releaseId, tx);
        const ownerId = input.ownerId ?? userId;
        await this.planService.assertOwner(plan.projectId, ownerId, tx);
        const cycle = await this.cycles.create(
          {
            projectId: plan.projectId,
            testPlanId: plan.id,
            name: input.name,
            description: input.description ?? null,
            ownerId,
            environmentId: input.environmentId ?? null,
            releaseId: releaseId ?? null,
            startDate: toDate(input.startDate),
            endDate: toDate(input.endDate),
            createdById: userId,
          },
          tx,
        );
        await this.record(tx, AuditAction.create, cycle.id, `Created test cycle ${cycle.name}`, {
          testPlanId: plan.id,
          environmentId: cycle.environmentId,
          releaseId: cycle.releaseId,
          ownerId,
        });
        return cycle.id;
      }),
    );
    return this.get(id);
  }

  async update(id: string, input: UpdateTestCycleInput): Promise<TestCycleView> {
    const visible = await this.requireCycle(id);
    await this.unique(() =>
      this.prisma.runInTransaction(async (tx) => {
        const current = await this.lockEditable(id, input.version, tx);
        const targetChange = input.environmentId !== undefined || input.releaseId !== undefined;
        if (targetChange && current.frozenAt !== null) {
          throw new ConflictError(
            `Test cycle ${current.name} is frozen; its environment and release cannot change`,
          );
        }
        if (targetChange) {
          await this.assertTarget(
            visible.projectId,
            visible.testPlanId,
            input.environmentId === undefined ? current.environmentId : input.environmentId,
            input.releaseId === undefined ? current.releaseId : input.releaseId,
            tx,
          );
        }
        if (input.ownerId !== undefined && input.ownerId !== null) {
          await this.planService.assertOwner(visible.projectId, input.ownerId, tx);
        }
        const startDate =
          input.startDate === undefined ? isoDay(current.startDate) : input.startDate;
        const endDate = input.endDate === undefined ? isoDay(current.endDate) : input.endDate;
        if (startDate !== null && endDate !== null && startDate > endDate) {
          throw new ValidationError('The end date cannot be before the start date');
        }
        await this.cycles.update(
          id,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
            ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
            ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
            ...(input.startDate === undefined ? {} : { startDate: toDate(input.startDate) }),
            ...(input.endDate === undefined ? {} : { endDate: toDate(input.endDate) }),
          },
          tx,
        );
        const { version: _version, ...changes } = input;
        await this.record(tx, AuditAction.update, id, `Updated test cycle ${current.name}`, {
          fields: Object.keys(changes),
          ...changes,
        });
      }),
    );
    return this.get(id);
  }

  async transition(
    id: string,
    action: TestCycleAction,
    input: TestCycleActionInput,
  ): Promise<TestCycleView> {
    const visible = await this.requireCycle(id);
    const target = TEST_CYCLE_ACTION_TARGET[action];
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockVersion(id, input.version, tx);
      const from = current.status as TestCycleStatus;
      if (!canTransitionTestCycle(from, target)) {
        throw new InvalidStateTransitionError(CYCLE, from, target);
      }
      const now = new Date();
      const data: Prisma.TestCycleUncheckedUpdateInput = { status: target };
      let frozen: { planVersion: number; cases: number } | null = null;
      if (target === 'active') {
        const plan = await this.cycles.lockPlan(visible.testPlanId, tx);
        if (plan === null) {
          throw new NotFoundError(PLAN);
        }
        if (plan.status !== 'active') {
          throw new ConflictError(
            `A cycle starts inside an active plan; ${plan.name} is ${plan.status}`,
          );
        }
        const scope = await this.plans.frozenScope(plan.id, plan.scopeVersion, tx);
        await this.cycles.writeScope({ id, projectId: visible.projectId }, scope, tx);
        frozen = { planVersion: plan.scopeVersion, cases: scope.length };
        Object.assign(data, { frozenAt: now, planScopeVersion: plan.scopeVersion, startedAt: now });
      } else if (target === 'completed') {
        data.completedAt = now;
      } else if (target === 'archived') {
        data.archivedAt = now;
      }
      await this.cycles.update(id, data, tx);
      await this.record(tx, AuditAction.update, id, `Test cycle ${current.name}: ${action}`, {
        status: { from, to: target },
        ...(frozen === null ? {} : { frozenScope: frozen }),
      });
    });
    return this.get(id);
  }

  /**
   * A cycle run must belong to the cycle's plan: a run of no plan is attached
   * to the plan as well; a run of another plan or another cycle is refused.
   */
  async attachRun(id: string, input: AttachCycleRunInput): Promise<TestCycleView> {
    const visible = await this.requireCycle(id);
    try {
      await this.prisma.runInTransaction(async (tx) => {
        const current = await this.lockEditable(id, undefined, tx);
        const run = await this.plans.findRun(visible.projectId, input.testRunId, tx);
        if (run === null) {
          throw new NotFoundError('Test run');
        }
        const owner = await this.cycles.planRun(visible.testPlanId, run.id, tx);
        if (owner === 'other') {
          throw new ConflictError('This test run belongs to another test plan');
        }
        if (owner === null) {
          await this.plans.attachRun(
            { id: visible.testPlanId, projectId: visible.projectId },
            run.id,
            tx,
          );
        }
        await this.cycles.attachRun({ id, projectId: visible.projectId }, run.id, tx);
        await this.record(
          tx,
          AuditAction.update,
          id,
          `Attached run ${run.name} to ${current.name}`,
          {
            testRunId: run.id,
            attachedToPlan: owner === null,
          },
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('This test run already belongs to a test cycle');
      }
      throw error;
    }
    return this.get(id);
  }

  async detachRun(id: string, testRunId: string): Promise<TestCycleView> {
    await this.requireCycle(id);
    await this.prisma.runInTransaction(async (tx) => {
      const current = await this.lockEditable(id, undefined, tx);
      const removed = await this.cycles.detachRun(id, testRunId, tx);
      if (removed.count === 0) {
        throw new NotFoundError('Test run in cycle');
      }
      await this.record(tx, AuditAction.update, id, `Detached a run from ${current.name}`, {
        testRunId,
      });
    });
    return this.get(id);
  }

  async progress(id: string): Promise<TestCycleProgressView> {
    const visible = await this.requireCycle(id);
    return this.prisma.runInTransaction(
      async (tx) => {
        const cycle = await this.cycles.findById(id, tx);
        if (cycle === null) {
          throw new NotFoundError(CYCLE);
        }
        const scope = await this.scopeOf(cycle, tx);
        const { runIds, rows } = await this.cycles.runCases(id, tx);
        const cases: Array<PlanCaseProgress & { inRun: boolean }> = scope.map((entry) =>
          caseProgress(
            entry,
            rows.filter((row) => row.testCaseId === entry.testCaseId),
          ),
        );
        const defects = await this.plans.defects(
          visible.projectId,
          runIds,
          runIds.length === 0 ? [] : scope.map((entry) => entry.testCaseId),
          tx,
        );
        return {
          cycle: { id: cycle.id, name: cycle.name, status: cycle.status as TestCycleStatus },
          scope: { frozen: cycle.frozenAt !== null, planVersion: cycle.planScopeVersion },
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

  /** Frozen: the cycle's own snapshot. Planned: whatever the plan holds now. */
  private async scopeOf(cycle: CycleRow, tx: PrismaTransaction): Promise<ScopeCase[]> {
    if (cycle.frozenAt !== null) {
      return this.cycles.frozenScope(cycle.id, tx);
    }
    const plan = await tx.testPlan.findUniqueOrThrow({ where: { id: cycle.testPlanId } });
    return plan.frozenAt === null
      ? this.plans.liveScope(plan.id, plan.projectId, tx)
      : this.plans.frozenScope(plan.id, plan.scopeVersion, tx);
  }

  private async requirePlan(id: string) {
    const plan = await this.cycles.findPlan(id);
    if (plan === null) {
      throw new NotFoundError(PLAN);
    }
    await this.access.assertRouteAccess(plan.projectId, PLAN);
    return plan;
  }

  private async requireCycle(id: string): Promise<CycleRow> {
    const cycle = await this.cycles.findById(id);
    if (cycle === null) {
      throw new NotFoundError(CYCLE);
    }
    await this.access.assertRouteAccess(cycle.projectId, CYCLE);
    return cycle;
  }

  private assertPlanOpen(plan: { name: string; status: string }) {
    if (plan.status !== 'draft' && plan.status !== 'active') {
      throw new ConflictError(`Test plan ${plan.name} is ${plan.status}; its cycles are read-only`);
    }
  }

  private async lockVersion(id: string, version: number | undefined, tx: PrismaTransaction) {
    const current = await this.cycles.lock(id, tx);
    if (current === null) {
      throw new NotFoundError(CYCLE);
    }
    if (version !== undefined && version !== current.version) {
      throw new ConflictError('This test cycle was changed by someone else; reload and try again', {
        version: current.version,
      });
    }
    return current;
  }

  private async lockEditable(id: string, version: number | undefined, tx: PrismaTransaction) {
    const current = await this.lockVersion(id, version, tx);
    if (!isEditableTestCycle(current.status as TestCycleStatus)) {
      throw new ConflictError(
        `Test cycle ${current.name} is ${current.status} and can no longer be changed`,
      );
    }
    const plan = await this.cycles.lockPlan(current.testPlanId, tx);
    if (plan === null) {
      throw new NotFoundError(PLAN);
    }
    this.assertPlanOpen(plan);
    return current;
  }

  /**
   * The environment must be live in the project and, when the plan lists
   * environments, one of them; the release must be live in the project.
   */
  private async assertTarget(
    projectId: string,
    planId: string,
    environmentId: string | null | undefined,
    releaseId: string | null | undefined,
    tx: PrismaTransaction,
  ): Promise<void> {
    if (environmentId !== undefined && environmentId !== null) {
      if ((await this.plans.liveEnvironments(projectId, [environmentId], tx)).length !== 1) {
        throw new NotFoundError('Environment');
      }
      const planned = await tx.testPlanEnvironment.findMany({
        where: { planId },
        select: { environmentId: true },
      });
      if (planned.length > 0 && !planned.some((row) => row.environmentId === environmentId)) {
        throw new ValidationError('The environment of a cycle must be one of its plan');
      }
    }
    if (releaseId !== undefined && releaseId !== null) {
      const release = await this.plans.findRelease(projectId, releaseId, tx);
      if (release === null) {
        throw new NotFoundError('Release');
      }
      if (release.status === 'archived') {
        throw new ConflictError('An archived release cannot be planned');
      }
    }
  }

  private async unique<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceError('test cycle', 'name');
      }
      throw error;
    }
  }

  private async view(row: CycleRow): Promise<TestCycleView> {
    const caseCount =
      row.frozenAt === null
        ? (await this.prisma.runInTransaction((tx) => this.scopeOf(row, tx))).length
        : await this.cycles.countScope(row.id);
    return {
      id: row.id,
      projectId: row.projectId,
      testPlan: row.testPlan,
      name: row.name,
      description: row.description,
      status: row.status as TestCycleStatus,
      owner: row.owner,
      environment: row.environment,
      release: row.release,
      runs: row.runs.map((entry) => entry.testRun),
      startDate: isoDay(row.startDate),
      endDate: isoDay(row.endDate),
      scope: {
        frozen: row.frozenAt !== null,
        frozenAt: row.frozenAt?.toISOString() ?? null,
        planVersion: row.planScopeVersion,
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
        entityType: 'TestCycle',
        entityId,
        summary,
        changes: changes as Prisma.InputJsonValue,
      },
      tx,
    );
  }
}
