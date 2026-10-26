import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, ProjectStatus, Sprint, SprintStatus } from '@prisma/client';
import {
  CloseSprintInput,
  CloseSprintResult,
  CreateSprintInput,
  ListSprintsQuery,
  SPRINT_TRANSITIONS,
  SprintDetailView,
  SprintItemsInput,
  SprintListView,
  SprintView,
  UpdateSprintInput,
  VELOCITY_WINDOW,
  VelocityView,
  buildPaginationMeta,
  computeSprintMetrics,
  computeVelocity,
  isClosedWorkItemStatus,
  isOpenSprint,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { toWorkItemView } from '../work-items/work-items.service';
import { SprintsRepository } from './sprints.repository';

/**
 * Sprints of a project (S4-F5). Lock order, always: activation advisory lock,
 * sprint rows (id order), work item rows (id order). A foreign, hidden or
 * missing sprint or item is answered like one that does not exist.
 */
@Injectable()
export class SprintsService {
  constructor(
    private readonly sprints: SprintsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateSprintInput, userId: string): Promise<SprintView> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    if (project.status === ProjectStatus.archived || project.archivedAt !== null) {
      throw new ConflictError('The project is archived; restore it before planning sprints');
    }
    const sprint = await this.prisma.runInTransaction(async (tx) => {
      const created = await this.sprints.create(
        {
          projectId: project.id,
          name: input.name,
          goal: blankToNull(input.goal),
          startDate: toDate(input.startDate),
          endDate: toDate(input.endDate),
          capacity: input.capacity ?? null,
          createdById: userId,
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'Sprint',
          entityId: created.id,
          summary: `Created sprint ${created.name}`,
        },
        tx,
      );
      return created;
    });
    return toSprintView(sprint);
  }

  async list(query: ListSprintsQuery): Promise<SprintListView> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return {
        data: [],
        meta: buildPaginationMeta(query, 0),
        velocity: { velocity: null, sprints: [] },
      };
    }
    const page = await this.sprints.list(query, projectId, query.status);
    return {
      data: page.data.map(toSprintView),
      meta: page.meta,
      velocity: await this.velocity(projectId),
    };
  }

  async velocity(projectId: string): Promise<VelocityView> {
    const completed = await this.sprints.completed(projectId, VELOCITY_WINDOW);
    const rows = completed.map((sprint) => ({
      id: sprint.id,
      name: sprint.name,
      committedEstimate: sprint.committedEstimate ?? 0,
      completedEstimate: sprint.completedEstimate ?? 0,
    }));
    return { velocity: computeVelocity(rows.map((row) => row.completedEstimate)), sprints: rows };
  }

  async get(id: string): Promise<SprintDetailView> {
    const sprint = await this.require(id);
    const items = await this.sprints.items(sprint.id);
    const metrics = computeSprintMetrics(
      items.map(toWorkItemView),
      sprint.capacity,
      sprint.status === SprintStatus.planned ? null : sprint.committedEstimate,
    );
    if (!isOpenSprint(sprint.status) && sprint.completedEstimate !== null) {
      metrics.completedEstimate = sprint.completedEstimate;
    }
    return { ...toSprintView(sprint), metrics, items: items.map(toWorkItemView) };
  }

  async update(id: string, input: UpdateSprintInput): Promise<SprintView> {
    const sprint = await this.require(id);
    await this.prisma.runInTransaction(async (tx) => {
      const [locked] = await this.sprints.lock([id], 'update', tx);
      if (locked === undefined) {
        throw new NotFoundError('Sprint');
      }
      assertOpen(locked.status);
      if (input.version !== undefined && input.version !== locked.version) {
        throw new ConflictError(`${sprint.name} was changed by someone else; reload it`, {
          version: locked.version,
        });
      }
      const current = await this.sprints.findById(id, tx);
      const startDate =
        input.startDate === undefined ? isoDay(current?.startDate ?? null) : input.startDate;
      const endDate =
        input.endDate === undefined ? isoDay(current?.endDate ?? null) : input.endDate;
      if (startDate !== null && endDate !== null && startDate > endDate) {
        throw new ValidationError('The end date cannot be before the start date', [
          { path: 'endDate', message: 'The end date cannot be before the start date' },
        ]);
      }
      await this.sprints.update(
        id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.goal === undefined ? {} : { goal: blankToNull(input.goal) }),
          ...(input.startDate === undefined ? {} : { startDate: toDate(input.startDate) }),
          ...(input.endDate === undefined ? {} : { endDate: toDate(input.endDate) }),
          ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'Sprint',
          entityId: id,
          summary: `Updated sprint ${input.name ?? sprint.name}`,
          changes: { fields: Object.keys(input).filter((key) => key !== 'version') },
        },
        tx,
      );
    });
    return toSprintView(await this.requireRow(id));
  }

  /** planned → active; one active sprint per project, the commitment is frozen. */
  async start(id: string): Promise<SprintView> {
    const sprint = await this.require(id);
    try {
      await this.prisma.runInTransaction(async (tx) => {
        await this.sprints.lockActivation(sprint.projectId, tx);
        const [locked] = await this.sprints.lock([id], 'update', tx);
        if (locked === undefined) {
          throw new NotFoundError('Sprint');
        }
        assertTransition(locked.status, SprintStatus.active);
        const active = await this.sprints.findActive(sprint.projectId, tx);
        if (active !== null) {
          throw new ConflictError(`Sprint ${active.name} is already active in this project`, {
            activeSprintId: active.id,
          });
        }
        const items = await this.sprints.lockSprintItems(id, tx);
        const metrics = computeSprintMetrics(items.map(toWorkItemView), null, null);
        const now = new Date();
        await this.sprints.update(
          id,
          {
            status: SprintStatus.active,
            startedAt: now,
            committedEstimate: metrics.scopeEstimate,
            ...(sprint.startDate === null ? { startDate: toDate(isoDay(now)) } : {}),
          },
          tx,
        );
        await this.audit.record(
          {
            action: AuditAction.update,
            entityType: 'Sprint',
            entityId: id,
            summary: `Started sprint ${sprint.name} with ${items.length} item(s)`,
            changes: {
              status: { from: locked.status, to: SprintStatus.active },
              committedEstimate: metrics.scopeEstimate,
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('Another sprint is already active in this project');
      }
      throw error;
    }
    return toSprintView(await this.requireRow(id));
  }

  complete(id: string, input: CloseSprintInput): Promise<CloseSprintResult> {
    return this.close(id, SprintStatus.completed, input);
  }

  cancel(id: string, input: CloseSprintInput): Promise<CloseSprintResult> {
    return this.close(id, SprintStatus.cancelled, input);
  }

  /** Unfinished items leave for the backlog or a planned sprint; the rest is frozen. */
  private async close(
    id: string,
    target: 'completed' | 'cancelled',
    input: CloseSprintInput,
  ): Promise<CloseSprintResult> {
    const sprint = await this.require(id);
    const destination = input.carryOverTo === 'backlog' ? null : input.carryOverTo;
    if (destination === id) {
      throw new ValidationError('Unfinished items cannot be carried over to the same sprint');
    }
    const carried = await this.prisma.runInTransaction(async (tx) => {
      const locked = await this.sprints.lock(
        destination === null ? [id] : [id, destination],
        'update',
        tx,
      );
      const self = locked.find((row) => row.id === id);
      if (self === undefined) {
        throw new NotFoundError('Sprint');
      }
      assertTransition(self.status, target);
      if (destination !== null) {
        const next = locked.find((row) => row.id === destination);
        if (next === undefined || next.projectId !== sprint.projectId) {
          throw new NotFoundError('Sprint');
        }
        if (next.status !== SprintStatus.planned) {
          throw new ConflictError('Unfinished items can only be carried over to a planned sprint', {
            status: next.status,
          });
        }
      }
      const items = await this.sprints.lockSprintItems(id, tx);
      const open = items.filter((item) => !isClosedWorkItemStatus(item.status));
      const metrics = computeSprintMetrics(items.map(toWorkItemView), null, null);
      await this.sprints.setSprint(
        open.map((item) => item.id),
        destination,
        tx,
      );
      await this.sprints.update(
        id,
        {
          status: target,
          closedAt: new Date(),
          completedEstimate: metrics.completedEstimate,
          ...(self.status === SprintStatus.planned
            ? { committedEstimate: metrics.scopeEstimate }
            : {}),
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'Sprint',
          entityId: id,
          summary: `${target === 'completed' ? 'Completed' : 'Cancelled'} sprint ${sprint.name}; ${open.length} unfinished item(s) to ${destination === null ? 'the backlog' : 'the next sprint'}`,
          changes: {
            status: { from: self.status, to: target },
            completedEstimate: metrics.completedEstimate,
            carriedOver: open.map((item) => item.key),
            carriedTo: destination ?? 'backlog',
          },
        },
        tx,
      );
      return open.length;
    });
    return {
      sprint: toSprintView(await this.requireRow(id)),
      carriedOver: carried,
      carriedTo: destination ?? 'backlog',
    };
  }

  /** Plans items into an open sprint, from the backlog or another open sprint. */
  async addItems(id: string, input: SprintItemsInput): Promise<SprintDetailView> {
    const sprint = await this.require(id);
    await this.moveItems(sprint, input.workItemIds, sprint.id);
    return this.get(id);
  }

  /** Sends items of an open sprint back to the backlog. */
  async removeItems(id: string, input: SprintItemsInput): Promise<SprintDetailView> {
    const sprint = await this.require(id);
    await this.moveItems(sprint, input.workItemIds, null, sprint.id);
    return this.get(id);
  }

  private async moveItems(
    sprint: Sprint,
    ids: readonly string[],
    to: string | null,
    from?: string,
  ): Promise<void> {
    const peek = await this.sprints.peekItems(sprint.projectId, ids);
    const involved = [
      sprint.id,
      ...peek.map((item) => item.sprintId).filter((value): value is string => value !== null),
    ];
    await this.prisma.runInTransaction(async (tx) => {
      const locked = await this.sprints.lock(involved, 'share', tx);
      const self = locked.find((row) => row.id === sprint.id);
      if (self === undefined) {
        throw new NotFoundError('Sprint');
      }
      assertOpen(self.status);
      const items = await this.sprints.lockItems(sprint.projectId, ids, tx);
      if (items.length !== ids.length) {
        throw new NotFoundError('Work item');
      }
      const status = new Map(locked.map((row) => [row.id, row.status]));
      for (const item of items) {
        if (item.sprintId !== null && !status.has(item.sprintId)) {
          throw new ConflictError(`${item.key} changed sprint meanwhile; try again`);
        }
        if (from !== undefined && item.sprintId !== from) {
          throw new ValidationError(`${item.key} is not in this sprint`);
        }
        if (item.sprintId !== null && item.sprintId !== to) {
          const source = status.get(item.sprintId);
          if (source !== undefined && !isOpenSprint(source)) {
            throw new ConflictError(`${item.key} belongs to a ${source} sprint and cannot move`);
          }
        }
        if (to !== null && isClosedWorkItemStatus(item.status) && item.sprintId !== to) {
          throw new ConflictError(`${item.key} is ${item.status} and cannot be planned`);
        }
      }
      const moving = items.filter((item) => item.sprintId !== to);
      await this.sprints.setSprint(
        moving.map((item) => item.id),
        to,
        tx,
      );
      if (moving.length > 0) {
        await this.audit.record(
          {
            action: AuditAction.update,
            entityType: 'Sprint',
            entityId: sprint.id,
            summary:
              to === null
                ? `Moved ${moving.length} item(s) from sprint ${sprint.name} to the backlog`
                : `Planned ${moving.length} item(s) into sprint ${sprint.name}`,
            changes: {
              items: moving.map((item) => ({ key: item.key, from: item.sprintId, to })),
            },
          },
          tx,
        );
      }
    });
  }

  private async require(id: string): Promise<Sprint> {
    const sprint = await this.sprints.findById(id);
    if (sprint === null) {
      throw new NotFoundError('Sprint');
    }
    await this.access.assertRouteAccess(sprint.projectId, 'Sprint');
    return sprint;
  }

  private async requireRow(id: string, tx?: PrismaTransaction): Promise<Sprint> {
    const sprint = await this.sprints.findById(id, tx);
    if (sprint === null) {
      throw new NotFoundError('Sprint');
    }
    return sprint;
  }
}

function assertOpen(status: SprintStatus): void {
  if (!isOpenSprint(status)) {
    throw new ConflictError(`This sprint is ${status} and can no longer be changed`, { status });
  }
}

function assertTransition(from: SprintStatus, to: SprintStatus): void {
  if (!SPRINT_TRANSITIONS[from].includes(to)) {
    throw new ConflictError(`A sprint cannot move from ${from} to ${to}`, {
      allowed: SPRINT_TRANSITIONS[from],
    });
  }
}

function blankToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

function toDate(value: string | null | undefined): Date | null {
  return value === undefined || value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

function isoDay(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

export function toSprintView(sprint: Sprint): SprintView {
  return {
    id: sprint.id,
    projectId: sprint.projectId,
    name: sprint.name,
    goal: sprint.goal,
    status: sprint.status,
    startDate: isoDay(sprint.startDate),
    endDate: isoDay(sprint.endDate),
    capacity: sprint.capacity,
    committedEstimate: sprint.committedEstimate,
    completedEstimate: sprint.completedEstimate,
    startedAt: sprint.startedAt?.toISOString() ?? null,
    closedAt: sprint.closedAt?.toISOString() ?? null,
    version: sprint.version,
    createdById: sprint.createdById,
    createdAt: sprint.createdAt.toISOString(),
    updatedAt: sprint.updatedAt.toISOString(),
  };
}
