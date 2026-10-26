import { RequirementLinksService } from '../requirement-links/requirement-links.service';
import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, ProjectStatus, Release, ReleaseStatus } from '@prisma/client';
import {
  CreateReleaseInput,
  ListReleasesQuery,
  Paginated,
  RELEASE_TRANSITIONS,
  ReleaseStatusCounts,
  ReleaseSummaryView,
  ReleaseTraceabilityRow,
  ReleaseTraceabilityView,
  ReleaseView,
  TestResultStatus,
  UpdateReleaseInput,
  buildPaginationMeta,
  isOpenRelease,
  computeImplementation,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import {
  ReleaseCaseStatus,
  ReleaseWithRunCount,
  ReleasesRepository,
  StatusCounts,
} from './releases.repository';

type ReleaseTarget = 'in_progress' | 'released' | 'archived';

@Injectable()
export class ReleasesService {
  constructor(
    private readonly releases: ReleasesRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly implementations: RequirementLinksService,
  ) {}

  async create(input: CreateReleaseInput, userId: string): Promise<ReleaseView> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    if (project.status === ProjectStatus.archived || project.archivedAt !== null) {
      throw new ConflictError('The project is archived; restore it before planning releases');
    }

    try {
      const created = await this.prisma.runInTransaction(async (tx) => {
        const release = await this.releases.create(
          {
            projectId: project.id,
            name: input.name,
            version: input.version,
            tag: input.tag ?? null,
            description: input.description ?? null,
            startDate: toDate(input.startDate),
            targetDate: toDate(input.targetDate),
            createdById: userId,
          },
          tx,
        );
        await this.audit.record(
          {
            action: AuditAction.create,
            entityType: 'Release',
            entityId: release.id,
            summary: `Created release ${release.name} (${release.version})`,
          },
          tx,
        );
        return release;
      });
      return toReleaseView({ ...created, runCount: 0 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('A release with this version already exists in the project', {
          version: input.version,
        });
      }
      throw error;
    }
  }

  async list(query: ListReleasesQuery): Promise<Paginated<ReleaseView>> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return { data: [], meta: buildPaginationMeta(query, 0) };
    }
    const page = await this.releases.list(query, {
      projectId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });
    return { data: page.data.map(toReleaseView), meta: page.meta };
  }

  async get(id: string): Promise<ReleaseView> {
    return toReleaseView(await this.require(id));
  }

  async update(id: string, input: UpdateReleaseInput): Promise<ReleaseView> {
    const current = await this.require(id);

    await this.prisma.runInTransaction(async (tx) => {
      const locked = await this.releases.lock(id, 'update', tx);
      if (locked === null) {
        throw new NotFoundError('Release');
      }
      if (locked.status === ReleaseStatus.archived) {
        throw new ConflictError('This release is archived and can no longer be changed');
      }

      const startDate = input.startDate === undefined ? isoDay(current.startDate) : input.startDate;
      const targetDate =
        input.targetDate === undefined ? isoDay(current.targetDate) : input.targetDate;
      if (startDate !== null && targetDate !== null && startDate > targetDate) {
        throw new ValidationError('The target date cannot be before the start date', [
          { path: 'targetDate', message: 'The target date cannot be before the start date' },
        ]);
      }

      await this.releases.update(
        id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.tag === undefined ? {} : { tag: input.tag }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.startDate === undefined ? {} : { startDate: toDate(input.startDate) }),
          ...(input.targetDate === undefined ? {} : { targetDate: toDate(input.targetDate) }),
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'Release',
          entityId: id,
          summary: `Updated release ${input.name ?? current.name} (${current.version})`,
          changes: { fields: Object.keys(input) },
        },
        tx,
      );
    });

    return this.get(id);
  }

  /**
   * The status is re-read under `FOR UPDATE`, so two concurrent transitions of
   * the same release have exactly one winner and the loser gets a 409.
   */
  async transition(id: string, target: ReleaseTarget): Promise<ReleaseView> {
    const current = await this.require(id);

    await this.prisma.runInTransaction(async (tx) => {
      const locked = await this.releases.lock(id, 'update', tx);
      if (locked === null) {
        throw new NotFoundError('Release');
      }
      const allowed = RELEASE_TRANSITIONS[locked.status];
      if (!allowed.includes(target)) {
        throw new ConflictError(`A release cannot move from ${locked.status} to ${target}`, {
          allowed,
        });
      }

      const now = new Date();
      await this.releases.update(
        id,
        {
          status: target,
          ...(target === 'released' ? { releasedAt: now } : {}),
          ...(target === 'archived' ? { archivedAt: now } : {}),
        },
        tx,
      );
      await this.audit.record(
        {
          action: target === 'archived' ? AuditAction.archive : AuditAction.update,
          entityType: 'Release',
          entityId: id,
          summary: `Moved release ${current.name} (${current.version}) from ${locked.status} to ${target}`,
          changes: { status: { from: locked.status, to: target } },
        },
        tx,
      );
    });

    return this.get(id);
  }

  async summary(id: string): Promise<ReleaseSummaryView> {
    const release = await this.require(id);

    const data = await this.prisma.runInTransaction(async (tx) => ({
      runs: await this.releases.runCounts(id, tx),
      cases: await this.releases.caseStatuses(id, tx),
      requirements: await this.releases.requirementCases(release.projectId, tx),
      defects: await this.releases.defectCounts(id, tx),
    }));

    const statusByCase = new Map(data.cases.map((row) => [row.testCaseId, row.status]));
    const verifying = new Map<string, TestResultStatus[]>();
    for (const row of data.requirements) {
      const list = verifying.get(row.requirementId) ?? [];
      if (row.testCaseId !== null) {
        list.push(statusByCase.get(row.testCaseId) ?? 'untested');
      }
      verifying.set(row.requirementId, list);
    }
    const statuses = [...verifying.values()];

    return {
      release: toReleaseView(release),
      runs: data.runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        environment: run.environment,
        createdAt: run.createdAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        counts: statusCounts(run.counts),
      })),
      cases: statusCounts(countStatuses(data.cases)),
      requirements: {
        total: statuses.length,
        verified: statuses.filter((list) => list.some((status) => status !== 'untested')).length,
        passing: statuses.filter(
          (list) => list.length > 0 && list.every((status) => status === 'passed'),
        ).length,
      },
      defects: data.defects,
    };
  }

  async traceability(id: string): Promise<ReleaseTraceabilityView> {
    const release = await this.require(id);

    const data = await this.prisma.runInTransaction(async (tx) => ({
      cases: await this.releases.caseStatuses(id, tx),
      requirements: await this.releases.requirementCases(release.projectId, tx),
    }));

    const byCase = new Map<string, ReleaseCaseStatus>(
      data.cases.map((row) => [row.testCaseId, row]),
    );
    const rows = new Map<string, ReleaseTraceabilityRow>();
    for (const row of data.requirements) {
      const entry = rows.get(row.requirementId) ?? {
        requirementId: row.requirementId,
        key: row.requirementKey,
        title: row.requirementTitle,
        status: row.requirementStatus,
        workItems: [],
        implementation: computeImplementation([]),
        cases: [],
      };
      if (row.testCaseId !== null && row.testCaseKey !== null && row.testCaseTitle !== null) {
        const inRelease = byCase.get(row.testCaseId);
        entry.cases.push({
          testCaseId: row.testCaseId,
          key: row.testCaseKey,
          title: row.testCaseTitle,
          status: inRelease?.status ?? 'untested',
          testRunId: inRelease?.testRunId ?? null,
          testRunName: inRelease?.testRunName ?? null,
        });
      }
      rows.set(row.requirementId, entry);
    }

    // Requirement → work item: only the implementing items planned in this release.
    if (await this.access.hasPermission(release.projectId, 'work_items.read')) {
      const implementation = await this.implementations.implementationOf(
        [...rows.keys()].map((requirementId) => ({ id: requirementId })),
      );
      for (const row of rows.values()) {
        const planned = (implementation.get(row.requirementId)?.workItems ?? []).filter(
          (item) => item.releaseId === id,
        );
        row.workItems = planned;
        row.implementation = computeImplementation(planned.map((item) => item.status));
      }
    }

    return { releaseId: id, rows: [...rows.values()] };
  }

  /**
   * Called by every path that points a run at a release (manual create/update
   * and CI ingestion), inside the caller's transaction. A release of another
   * project or organization answers exactly like one that does not exist; the
   * share lock keeps it open until the caller commits.
   */
  async assertAttachable(
    releaseId: string,
    projectId: string,
    tx: PrismaTransaction,
  ): Promise<void> {
    const locked = await this.releases.lock(releaseId, 'share', tx);
    if (locked === null || locked.projectId !== projectId) {
      throw new NotFoundError('Release');
    }
    if (!isOpenRelease(locked.status)) {
      throw new ConflictError(`Runs cannot be attached to a ${locked.status} release`, {
        status: locked.status,
      });
    }
  }

  /** Resolves the version CI sends to a release of the key's project. */
  async findIdByVersion(
    projectId: string,
    version: string,
    tx: PrismaTransaction,
  ): Promise<string> {
    const release = await this.releases.findByVersion(projectId, version, tx);
    if (release === null) {
      throw new NotFoundError('Release');
    }
    return release.id;
  }

  private async require(id: string): Promise<ReleaseWithRunCount> {
    const release = await this.releases.findById(id);
    if (release === null) {
      throw new NotFoundError('Release');
    }
    await this.access.assertRouteAccess(release.projectId, 'Release');
    return release;
  }
}

function toDate(value: string | null | undefined): Date | null {
  return value === undefined || value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

function isoDay(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function countStatuses(rows: ReadonlyArray<{ status: TestResultStatus }>): StatusCounts {
  const counts: StatusCounts = { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const row of rows) {
    counts[row.status] += 1;
  }
  return counts;
}

export function statusCounts(counts: StatusCounts): ReleaseStatusCounts {
  const total = counts.untested + counts.passed + counts.failed + counts.blocked + counts.skipped;
  const executed = total - counts.untested;
  return {
    ...counts,
    total,
    executed,
    passRate: executed === 0 ? null : Math.round((counts.passed / executed) * 1000) / 10,
  };
}

export function toReleaseView(release: Release & { runCount: number }): ReleaseView {
  return {
    id: release.id,
    projectId: release.projectId,
    name: release.name,
    version: release.version,
    tag: release.tag,
    description: release.description,
    status: release.status,
    startDate: isoDay(release.startDate),
    targetDate: isoDay(release.targetDate),
    releasedAt: release.releasedAt?.toISOString() ?? null,
    archivedAt: release.archivedAt?.toISOString() ?? null,
    createdById: release.createdById,
    createdAt: release.createdAt.toISOString(),
    updatedAt: release.updatedAt.toISOString(),
    runCount: release.runCount,
  };
}
