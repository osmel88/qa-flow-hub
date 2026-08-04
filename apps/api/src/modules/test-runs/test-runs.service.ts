import { Injectable } from '@nestjs/common';
import {
  AuditAction,
  Prisma,
  TestCase,
  TestResult,
  TestResultStatus,
  TestRun,
  TestRunCase,
  TestStep,
} from '@prisma/client';
import {
  AddRunCasesInput,
  AssignRunCasesInput,
  CreateTestRunInput,
  ListRunCasesQuery,
  ListTestRunsQuery,
  Paginated,
  RecordResultInput,
  RunCaseSelection,
  RunCaseSnapshot,
  RunCaseView,
  RunProgress,
  TestResultView,
  TestRunView,
  UpdateTestRunInput,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantContextService } from '../../database/tenant-context.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { OrganizationMembersRepository } from '../organizations/organization-members.repository';
import { ProjectsRepository } from '../projects/projects.repository';
import { TestRunsRepository } from './test-runs.repository';

const RUN_TRANSITIONS: Record<string, string[]> = {
  planned: ['in_progress', 'aborted'],
  in_progress: ['completed', 'aborted'],
  completed: [],
  aborted: [],
};

@Injectable()
export class TestRunsService {
  constructor(
    private readonly runs: TestRunsRepository,
    private readonly projects: ProjectsRepository,
    private readonly members: OrganizationMembersRepository,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // --- Runs ----------------------------------------------------------------

  async create(input: CreateTestRunInput, userId: string): Promise<TestRunView> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }

    const run = await this.prisma.runInTransaction(async (tx) => {
      const created = await this.runs.create(
        {
          projectId: project.id,
          name: input.name,
          ...nullableText('description', input.description),
          ...nullableText('milestone', input.milestone),
          ...nullableText('environment', input.environment),
          createdById: userId,
        },
        tx,
      );

      if (input.selection !== undefined) {
        await this.includeCases(created, input.selection, tx);
      }

      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'TestRun',
          entityId: created.id,
          summary: `Created run ${created.name}`,
        },
        tx,
      );

      return created;
    });

    return this.view(run);
  }

  async list(query: ListTestRunsQuery): Promise<Paginated<TestRunView>> {
    const page = await this.runs.list(query, {
      projectId: query.projectId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.milestone === undefined ? {} : { milestone: query.milestone }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });

    return {
      data: await Promise.all(page.data.map((run) => this.view(run))),
      meta: page.meta,
    };
  }

  async get(id: string): Promise<TestRunView> {
    return this.view(await this.require(id));
  }

  async update(id: string, input: UpdateTestRunInput): Promise<TestRunView> {
    const run = await this.require(id);
    this.assertOpen(run);

    const updated = await this.runs.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    });
    if (updated === null) {
      throw new NotFoundError('Test run');
    }

    await this.audit.record({
      action: AuditAction.update,
      entityType: 'TestRun',
      entityId: id,
      summary: `Updated run ${updated.name}`,
    });

    return this.view(updated);
  }

  /**
   * Runs move planned → in_progress → completed, or to aborted from either.
   * Completed and aborted are terminal: a closed run is a report, and a report
   * that can change is not a report.
   */
  async transition(
    id: string,
    target: 'in_progress' | 'completed' | 'aborted',
  ): Promise<TestRunView> {
    const run = await this.require(id);

    const allowed = RUN_TRANSITIONS[run.status] ?? [];
    if (!allowed.includes(target)) {
      throw new ConflictError(`A run cannot move from ${run.status} to ${target}`, { allowed });
    }

    const updated = await this.runs.update(id, {
      status: target,
      ...(target === 'in_progress' ? { startedAt: new Date() } : {}),
      ...(target === 'completed' || target === 'aborted' ? { completedAt: new Date() } : {}),
    });
    if (updated === null) {
      throw new NotFoundError('Test run');
    }

    await this.audit.record({
      action: AuditAction.update,
      entityType: 'TestRun',
      entityId: id,
      summary: `Moved run ${updated.name} from ${run.status} to ${target}`,
      changes: { status: { from: run.status, to: target } },
    });

    return this.view(updated);
  }

  async remove(id: string): Promise<void> {
    const run = await this.require(id);
    if (!(await this.runs.softDelete(id))) {
      throw new NotFoundError('Test run');
    }

    await this.audit.record({
      action: AuditAction.delete,
      entityType: 'TestRun',
      entityId: id,
      summary: `Deleted run ${run.name}`,
    });
  }

  // --- Cases in a run ------------------------------------------------------

  async addCases(id: string, input: AddRunCasesInput): Promise<{ added: number }> {
    const run = await this.require(id);
    this.assertOpen(run);

    const added = await this.prisma.runInTransaction((tx) =>
      this.includeCases(run, input.selection, tx),
    );

    await this.audit.record({
      action: AuditAction.update,
      entityType: 'TestRun',
      entityId: id,
      summary: `Added ${added} case(s) to run ${run.name}`,
    });

    return { added };
  }

  async listCases(id: string, query: ListRunCasesQuery): Promise<Paginated<RunCaseView>> {
    await this.require(id);

    const page = await this.runs.listRunCases(id, query, {
      ...(query.status === undefined ? {} : { latestStatus: query.status }),
      ...(query.assignedToId === undefined ? {} : { assignedToId: query.assignedToId }),
    });

    return { data: page.data.map(toRunCaseView), meta: page.meta };
  }

  async removeCase(runId: string, runCaseId: string): Promise<void> {
    const run = await this.require(runId);
    this.assertOpen(run);

    const runCase = await this.requireRunCase(runCaseId, runId);
    if (runCase.latestStatus !== TestResultStatus.untested) {
      // Removing it would delete the results by cascade, and results are the
      // record of what was executed.
      throw new ConflictError('A case that already has results cannot be removed from the run');
    }

    if (!(await this.runs.removeRunCase(runCaseId))) {
      throw new NotFoundError('Case in run');
    }
  }

  async assign(runId: string, input: AssignRunCasesInput): Promise<{ assigned: number }> {
    const run = await this.require(runId);
    this.assertOpen(run);

    if (input.assignedToId !== null) {
      const membership = await this.members.findActiveMembership(
        input.assignedToId,
        this.tenant.requireOrganizationId(),
      );
      if (membership === null) {
        throw new ValidationError('The assignee is not a member of this organization');
      }
    }

    // Scoped by tenant, but ids from another run of the same organization would
    // otherwise be assignable through this run's endpoint.
    for (const id of input.runCaseIds) {
      await this.requireRunCase(id, runId);
    }

    const assigned = await this.runs.assignRunCases(input.runCaseIds, input.assignedToId);

    await this.audit.record({
      action: AuditAction.update,
      entityType: 'TestRun',
      entityId: runId,
      summary:
        input.assignedToId === null
          ? `Unassigned ${assigned} case(s) in run ${run.name}`
          : `Assigned ${assigned} case(s) in run ${run.name}`,
    });

    return { assigned };
  }

  // --- Results -------------------------------------------------------------

  /**
   * Recording a result inserts a row and refreshes the projection on the run
   * case. Nothing is updated: re-testing appends, and the history of attempts
   * is part of what the customer bought.
   */
  async recordResult(
    runId: string,
    runCaseId: string,
    input: RecordResultInput,
    userId: string,
    role: string,
  ): Promise<TestResultView> {
    const run = await this.require(runId);
    if (run.status === 'completed' || run.status === 'aborted') {
      throw new ConflictError('This run is closed. Results can no longer be recorded.');
    }

    const runCase = await this.requireRunCase(runCaseId, runId);

    // Testers execute what they were given. Anyone senior can record for
    // anybody, because leads do fill in for absent testers.
    if (
      role === 'tester' &&
      runCase.assignedToId !== null &&
      runCase.assignedToId !== userId
    ) {
      throw new ForbiddenError('This case is assigned to somebody else');
    }

    const snapshot = runCase.caseSnapshot as unknown as RunCaseSnapshot;
    if (input.stepResults !== undefined) {
      const positions = new Set(snapshot.steps.map((step) => step.position));
      for (const stepResult of input.stepResults) {
        if (!positions.has(stepResult.position)) {
          throw new ValidationError(
            `Step ${stepResult.position} does not exist in the executed version of this case`,
          );
        }
      }
    }

    const result = await this.prisma.runInTransaction(async (tx) => {
      const created = await this.runs.createResult(
        {
          testRunId: runId,
          testRunCaseId: runCaseId,
          status: input.status,
          ...nullableText('comment', input.comment),
          ...(input.elapsedSeconds === undefined || input.elapsedSeconds === null
            ? {}
            : { elapsedSeconds: input.elapsedSeconds }),
          ...(input.stepResults === undefined
            ? {}
            : { stepResults: input.stepResults as unknown as Prisma.InputJsonValue }),
          executedById: userId,
        },
        tx,
      );

      await this.runs.setLatestStatus(runCaseId, input.status, tx);

      // The first result is what actually starts a run: a planned run with
      // results in it would misreport every dashboard.
      if (run.status === 'planned') {
        await this.runs.update(runId, { status: 'in_progress', startedAt: new Date() }, tx);
      }

      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'TestResult',
          entityId: created.id,
          summary: `Recorded ${input.status} for ${snapshot.key} in run ${run.name}`,
        },
        tx,
      );

      return created;
    });

    return toResultView(result);
  }

  async listResults(runId: string, runCaseId: string): Promise<TestResultView[]> {
    await this.require(runId);
    await this.requireRunCase(runCaseId, runId);

    return (await this.runs.listResults(runCaseId)).map(toResultView);
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Freezes the selected cases into the run. The snapshot is the whole point:
   * editing a case afterwards must not change what a past run reported.
   */
  private async includeCases(
    run: TestRun,
    selection: RunCaseSelection,
    tx: PrismaTransaction,
  ): Promise<number> {
    const where: Prisma.TestCaseWhereInput = { projectId: run.projectId };

    if (selection.testCaseIds !== undefined) {
      where.id = { in: selection.testCaseIds };
    } else {
      if (selection.suiteId !== undefined) {
        where.suiteId = selection.suiteId;
      }
      if (selection.sectionId !== undefined) {
        where.sectionId = selection.sectionId;
      }
      if (selection.tag !== undefined) {
        where.tags = { has: selection.tag };
      }
      if (selection.priority !== undefined) {
        where.priority = selection.priority;
      }
    }

    const cases = await this.runs.casesForSelection(where, tx);
    if (cases.length === 0) {
      throw new ValidationError('The selection matched no runnable test case');
    }
    if (selection.testCaseIds !== undefined && cases.length !== selection.testCaseIds.length) {
      // Silently dropping ids would hide a typo, a deleted case or an attempt
      // to pull in another project's cases.
      throw new ValidationError(
        'Some selected cases do not exist, are archived, or belong to another project',
      );
    }

    const existing = new Set(
      (await this.runs.listCaseIdsInRun(run.id, tx)).map((row) => row.testCaseId),
    );
    const fresh = cases.filter((testCase) => !existing.has(testCase.id));
    const offset = await this.runs.maxPosition(run.id, tx);

    return this.runs.addRunCases(
      fresh.map((testCase, index) => ({
        testRunId: run.id,
        testCaseId: testCase.id,
        caseSnapshot: snapshotOf(testCase) as unknown as Prisma.InputJsonValue,
        caseVersion: testCase.version,
        position: offset + index + 1,
      })),
      tx,
    );
  }

  private async view(run: TestRun): Promise<TestRunView> {
    return toTestRunView(run, buildProgress(await this.runs.progressOf(run.id)));
  }

  private assertOpen(run: TestRun): void {
    if (run.status === 'completed' || run.status === 'aborted') {
      throw new ConflictError('This run is closed and can no longer be changed');
    }
  }

  private async require(id: string): Promise<TestRun> {
    const run = await this.runs.findById(id);
    if (run === null) {
      throw new NotFoundError('Test run');
    }
    return run;
  }

  private async requireRunCase(id: string, runId: string): Promise<TestRunCase> {
    const runCase = await this.runs.findRunCaseById(id);
    if (runCase === null || runCase.testRunId !== runId) {
      throw new NotFoundError('Case in run');
    }
    return runCase;
  }
}

function nullableText<K extends string>(
  key: K,
  value: string | null | undefined,
): Record<K, string> | Record<string, never> {
  return value === undefined || value === null ? {} : ({ [key]: value } as Record<K, string>);
}

function snapshotOf(testCase: TestCase & { steps: TestStep[] }): RunCaseSnapshot {
  return {
    key: testCase.key,
    title: testCase.title,
    preconditions: testCase.preconditions,
    expectedResult: testCase.expectedResult,
    priority: testCase.priority,
    type: testCase.type,
    steps: testCase.steps.map((step) => ({
      position: step.position,
      action: step.action,
      expectedResult: step.expectedResult,
    })),
  };
}

export function buildProgress(
  rows: Array<{ status: TestResultStatus; count: number }>,
): RunProgress {
  const progress: RunProgress = {
    untested: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    total: 0,
    executed: 0,
    completion: 0,
  };

  for (const row of rows) {
    progress[row.status] = row.count;
    progress.total += row.count;
  }

  progress.executed = progress.total - progress.untested;
  progress.completion =
    progress.total === 0 ? 0 : Math.round((progress.executed / progress.total) * 1000) / 10;

  return progress;
}

function toTestRunView(run: TestRun, progress: RunProgress): TestRunView {
  return {
    id: run.id,
    projectId: run.projectId,
    name: run.name,
    description: run.description,
    milestone: run.milestone,
    environment: run.environment,
    status: run.status,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdById: run.createdById,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    progress,
  };
}

function toRunCaseView(runCase: TestRunCase): RunCaseView {
  return {
    id: runCase.id,
    testRunId: runCase.testRunId,
    testCaseId: runCase.testCaseId,
    caseVersion: runCase.caseVersion,
    snapshot: runCase.caseSnapshot as unknown as RunCaseSnapshot,
    assignedToId: runCase.assignedToId,
    latestStatus: runCase.latestStatus,
    position: runCase.position,
  };
}

function toResultView(result: TestResult): TestResultView {
  return {
    id: result.id,
    testRunCaseId: result.testRunCaseId,
    status: result.status as TestResultView['status'],
    comment: result.comment,
    elapsedSeconds: result.elapsedSeconds,
    stepResults: (result.stepResults as TestResultView['stepResults']) ?? null,
    executedById: result.executedById,
    executedAt: result.executedAt.toISOString(),
  };
}
