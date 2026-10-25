import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, ProjectStatus, WorkItem } from '@prisma/client';
import {
  CreateWorkItemInput,
  ListWorkItemsQuery,
  Paginated,
  UpdateWorkItemInput,
  WorkItemDetailView,
  WorkItemView,
  buildPaginationMeta,
  canBeParentOf,
  isClosedWorkItemStatus,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantContextService } from '../../database/tenant-context.service';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { OrganizationMembersRepository } from '../organizations/organization-members.repository';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { ReleasesService } from '../releases/releases.service';
import { WorkItemsRepository } from './work-items.repository';

const AUDITED_FIELDS = [
  'title',
  'description',
  'type',
  'status',
  'priority',
  'assigneeId',
  'estimate',
  'labels',
  'parentId',
  'releaseId',
] as const;

/**
 * Work items are the backlog. Every reference an item holds (parent, release,
 * assignee) is checked against the item's own project: an id from another
 * project or tenant is answered exactly like an id that does not exist.
 */
@Injectable()
export class WorkItemsService {
  constructor(
    private readonly items: WorkItemsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly members: OrganizationMembersRepository,
    private readonly releases: ReleasesService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateWorkItemInput, userId: string): Promise<WorkItemView> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    if (project.status === ProjectStatus.archived || project.archivedAt !== null) {
      throw new ConflictError('The project is archived; restore it before adding work items');
    }
    await this.assertAssignee(project.id, input.assigneeId);

    const created = await this.prisma.runInTransaction(async (tx) => {
      const parentId = input.parentId ?? null;
      if (parentId !== null) {
        await this.items.lockTree(project.id, tx);
        await this.assertParent(project.id, parentId, input.type, tx);
      }
      const releaseId = input.releaseId ?? null;
      if (releaseId !== null) {
        await this.releases.assertAttachable(releaseId, project.id, tx);
      }
      const key = await this.projects.nextKey(project.id, 'workItemCounter', 'W', tx);
      const item = await this.items.create(
        {
          projectId: project.id,
          key,
          title: input.title,
          description: blankToNull(input.description),
          type: input.type,
          status: input.status,
          priority: input.priority,
          estimate: input.estimate ?? null,
          labels: input.labels,
          parentId,
          releaseId,
          assigneeId: input.assigneeId ?? null,
          reporterId: userId,
          completedAt: isClosedWorkItemStatus(input.status) ? new Date() : null,
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'WorkItem',
          entityId: item.id,
          summary: `Created ${item.type} ${item.key}: ${item.title}`,
        },
        tx,
      );
      return item;
    });

    return toWorkItemView(created);
  }

  async list(query: ListWorkItemsQuery): Promise<Paginated<WorkItemView>> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return { data: [], meta: buildPaginationMeta(query, 0) };
    }
    const ref = (value: string | undefined): string | null | undefined =>
      value === undefined ? undefined : value === 'none' ? null : value;
    const assigneeId = ref(query.assigneeId);
    const parentId = ref(query.parentId);
    const releaseId = ref(query.releaseId);
    const page = await this.items.list(query, {
      projectId,
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      ...(assigneeId === undefined ? {} : { assigneeId }),
      ...(query.reporterId === undefined ? {} : { reporterId: query.reporterId }),
      ...(parentId === undefined ? {} : { parentId }),
      ...(releaseId === undefined ? {} : { releaseId }),
      ...(query.label === undefined ? {} : { label: query.label }),
      ...(query.open === undefined ? {} : { open: query.open === 'true' }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });
    return { data: page.data.map(toWorkItemView), meta: page.meta };
  }

  async get(id: string): Promise<WorkItemDetailView> {
    const item = await this.require(id);
    const [ancestors, children] = await Promise.all([
      this.items.ancestors(item),
      this.items.children(item.id),
    ]);
    return {
      ...toWorkItemView(item),
      ancestors: ancestors.map(({ id: ancestorId, key, title, type }) => ({
        id: ancestorId,
        key,
        title,
        type,
      })),
      children: children.map(({ id: childId, key, title, type, status }) => ({
        id: childId,
        key,
        title,
        type,
        status,
      })),
    };
  }

  async update(id: string, input: UpdateWorkItemInput): Promise<WorkItemView> {
    const item = await this.require(id);
    if (input.assigneeId !== undefined && input.assigneeId !== item.assigneeId) {
      await this.assertAssignee(item.projectId, input.assigneeId);
    }

    const updated = await this.prisma.runInTransaction(async (tx) => {
      const reshapes = input.parentId !== undefined || input.type !== undefined;
      if (reshapes) {
        await this.items.lockTree(item.projectId, tx);
      }
      const current = await this.items.lock(id, tx);
      if (current === null) {
        throw new NotFoundError('Work item');
      }
      if (input.version !== undefined && input.version !== current.version) {
        throw new ConflictError(
          `${current.key} was changed by someone else; reload it and try again`,
          { version: current.version },
        );
      }

      const type = input.type ?? current.type;
      const parentId = input.parentId === undefined ? current.parentId : input.parentId;
      if (parentId !== null && (input.parentId !== undefined || input.type !== undefined)) {
        if (parentId === id) {
          throw new ValidationError('A work item cannot be its own parent');
        }
        await this.assertParent(current.projectId, parentId, type, tx);
      }
      if (input.type !== undefined && input.type !== current.type) {
        const blocking = (await this.items.children(id, tx)).filter(
          (child) => !canBeParentOf(type, child.type),
        );
        if (blocking.length > 0) {
          throw new ValidationError(
            `A ${type} cannot contain ${blocking.map((child) => `${child.type} ${child.key}`).join(', ')}`,
          );
        }
      }

      if (input.releaseId !== undefined && input.releaseId !== current.releaseId) {
        if (input.releaseId !== null) {
          await this.releases.assertAttachable(input.releaseId, current.projectId, tx);
        }
        if (current.releaseId !== null) {
          // Moving an item out of a shipped release rewrites that release's history.
          await this.releases.assertAttachable(current.releaseId, current.projectId, tx);
        }
      }

      const status = input.status ?? current.status;
      const completedAt =
        input.status === undefined || input.status === current.status
          ? undefined
          : isClosedWorkItemStatus(status)
            ? new Date()
            : null;

      const row = await this.items.update(
        id,
        {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined
            ? {}
            : { description: blankToNull(input.description) }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
          ...(input.estimate === undefined ? {} : { estimate: input.estimate }),
          ...(input.labels === undefined ? {} : { labels: input.labels }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
          ...(completedAt === undefined ? {} : { completedAt }),
        },
        tx,
      );
      if (row === null) {
        throw new NotFoundError('Work item');
      }

      const changes = diff(current, row);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'WorkItem',
          entityId: id,
          summary:
            changes['status'] === undefined
              ? `Updated ${row.key}`
              : `Moved ${row.key} from ${current.status} to ${row.status}`,
          ...(Object.keys(changes).length === 0 ? {} : { changes }),
        },
        tx,
      );
      return row;
    });

    return toWorkItemView(updated);
  }

  async remove(id: string): Promise<void> {
    const item = await this.require(id);
    await this.prisma.runInTransaction(async (tx) => {
      await this.items.lockTree(item.projectId, tx);
      const current = await this.items.lock(id, tx);
      if (current === null) {
        throw new NotFoundError('Work item');
      }
      const children = await this.items.children(id, tx);
      if (children.length > 0) {
        throw new ConflictError(
          `${current.key} has ${children.length} child item(s); move or delete them first`,
          { children: children.map((child) => child.key) },
        );
      }
      if (!(await this.items.softDelete(id, tx))) {
        throw new NotFoundError('Work item');
      }
      await this.audit.record(
        {
          action: AuditAction.delete,
          entityType: 'WorkItem',
          entityId: id,
          summary: `Deleted ${current.type} ${current.key}`,
        },
        tx,
      );
    });
  }

  /** The parent must be a live item of the same project and rank above the child. */
  private async assertParent(
    projectId: string,
    parentId: string,
    childType: WorkItem['type'],
    tx: PrismaTransaction,
  ): Promise<void> {
    const parent = await this.items.findById(parentId, tx);
    if (parent === null || parent.projectId !== projectId) {
      throw new NotFoundError('Parent work item');
    }
    if (!canBeParentOf(parent.type, childType)) {
      throw new ValidationError(`A ${parent.type} cannot contain a ${childType}`);
    }
  }

  private async assertAssignee(
    projectId: string,
    assigneeId: string | null | undefined,
  ): Promise<void> {
    if (assigneeId === undefined || assigneeId === null) {
      return;
    }
    const membership = await this.members.findActiveMembership(
      assigneeId,
      this.tenant.requireOrganizationId(),
    );
    if (membership === null) {
      throw new ValidationError('The assignee is not a member of this organization');
    }
    if (!(await this.access.memberSees(projectId, assigneeId, membership.role))) {
      throw new ValidationError('The assignee has no access to this project');
    }
  }

  private async require(id: string): Promise<WorkItem> {
    const item = await this.items.findById(id);
    if (item === null) {
      throw new NotFoundError('Work item');
    }
    await this.access.assertRouteAccess(item.projectId, 'Work item');
    return item;
  }
}

function blankToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

type Change = { from: Prisma.InputJsonValue | null; to: Prisma.InputJsonValue | null };

function diff(before: WorkItem, after: WorkItem): Record<string, Change> {
  const changes: Record<string, Change> = {};
  for (const field of AUDITED_FIELDS) {
    const from = before[field];
    const to = after[field];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes[field] = { from, to };
    }
  }
  return changes;
}

export function toWorkItemView(item: WorkItem): WorkItemView {
  return {
    id: item.id,
    projectId: item.projectId,
    key: item.key,
    title: item.title,
    description: item.description,
    type: item.type,
    status: item.status,
    priority: item.priority,
    assigneeId: item.assigneeId,
    reporterId: item.reporterId,
    estimate: item.estimate,
    labels: item.labels,
    parentId: item.parentId,
    releaseId: item.releaseId,
    version: item.version,
    completedAt: item.completedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
