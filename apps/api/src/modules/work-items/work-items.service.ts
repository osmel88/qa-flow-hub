import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, ProjectStatus, WorkItem } from '@prisma/client';
import {
  ReparentWorkItemInput,
  WORK_ITEM_MAX_DEPTH,
  WORK_ITEM_TREE_MAX_ITEMS,
  WorkItemRollup,
  WorkItemTreeNode,
  WorkItemTreeQuery,
  WorkItemTreeView,
  computeRollup,
  BACKLOG_MAX_ITEMS,
  BACKLOG_RANK_STEP,
  BacklogGroup,
  BacklogQuery,
  BacklogView,
  BulkUpdateWorkItemsInput,
  BulkUpdateWorkItemsResult,
  MoveWorkItemInput,
  backlogTotals,
  normalizeLabels,
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
      await this.items.lockBacklog(project.id, tx);
      const rank = ((await this.items.maxRank(project.id, tx)) ?? 0) + BACKLOG_RANK_STEP;
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
          rank,
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
      rollup: await this.rollupOf(item),
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
      const parentKey =
        row.parentId === null ? null : ((await this.items.findById(row.parentId, tx))?.key ?? null);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'WorkItem',
          entityId: id,
          summary:
            changes['status'] !== undefined
              ? `Moved ${row.key} from ${current.status} to ${row.status}`
              : changes['parentId'] !== undefined && Object.keys(changes).length === 1
                ? `Reparented ${row.key} ${row.parentId === null ? 'to the top level' : `under ${parentKey ?? row.parentId}`}`
                : `Updated ${row.key}`,
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

  // --- Hierarchy (S4-F3) ----------------------------------------------------

  /** Aggregates over every live descendant of one item. */
  private async rollupOf(item: WorkItem): Promise<WorkItemRollup> {
    const rows = await this.items.treeItems(item.projectId, WORK_ITEM_TREE_MAX_ITEMS);
    const children = childrenIndex(rows);
    const descendants: WorkItem[] = [];
    const stack = [...(children.get(item.id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined) break;
      descendants.push(next);
      stack.push(...(children.get(next.id) ?? []));
    }
    return computeRollup(descendants);
  }

  /**
   * The project's hierarchy as a tree, every level in backlog order, with
   * rollups. With filters, matching items keep their ancestors for context.
   */
  async tree(query: WorkItemTreeQuery, userId: string): Promise<WorkItemTreeView> {
    const filtered =
      query.type !== undefined ||
      query.status !== undefined ||
      query.assigneeId !== undefined ||
      query.search !== undefined;
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return {
        projectId: query.projectId,
        roots: [],
        totals: computeRollup([]),
        filtered,
        truncated: false,
      };
    }
    const rows = await this.items.treeItems(projectId, WORK_ITEM_TREE_MAX_ITEMS + 1);
    const truncated = rows.length > WORK_ITEM_TREE_MAX_ITEMS;
    const live = rows.slice(0, WORK_ITEM_TREE_MAX_ITEMS);
    const byId = new Map(live.map((row) => [row.id, row]));
    const children = childrenIndex(live);

    if (query.rootId !== undefined && !byId.has(query.rootId)) {
      throw new NotFoundError('Work item');
    }
    const assigneeId =
      query.assigneeId === 'me' ? userId : query.assigneeId === 'none' ? null : query.assigneeId;
    const needle = query.search?.toLowerCase();
    const matches = (row: WorkItem): boolean =>
      (query.type === undefined || row.type === query.type) &&
      (query.status === undefined || row.status === query.status) &&
      (assigneeId === undefined || row.assigneeId === assigneeId) &&
      (needle === undefined ||
        row.title.toLowerCase().includes(needle) ||
        row.key.toLowerCase().includes(needle));

    const build = (
      row: WorkItem,
      depth: number,
    ): { node: WorkItemTreeNode; all: WorkItem[] } | null => {
      const built =
        depth >= WORK_ITEM_MAX_DEPTH + 2
          ? []
          : (children.get(row.id) ?? []).flatMap((child) => build(child, depth + 1) ?? []);
      const descendants = built.flatMap((entry) => entry.all);
      const matched = matches(row);
      if (filtered && !matched && built.length === 0) {
        return null;
      }
      return {
        node: {
          item: toWorkItemView(row),
          rollup: computeRollup(descendants),
          matched,
          children: built.map((entry) => entry.node),
        },
        all: [row, ...descendants],
      };
    };

    const tops =
      query.rootId === undefined
        ? live.filter((row) => row.parentId === null || !byId.has(row.parentId))
        : live.filter((row) => row.id === query.rootId);
    const built = tops.flatMap((row) => build(row, 1) ?? []);
    return {
      projectId,
      roots: built.map((entry) => entry.node),
      totals: computeRollup(built.flatMap((entry) => entry.all)),
      filtered,
      truncated,
    };
  }

  /** Moves an item in the hierarchy (same checks and locks as an edit of `parentId`). */
  async reparent(id: string, input: ReparentWorkItemInput): Promise<WorkItemView> {
    return this.update(id, {
      parentId: input.parentId,
      ...(input.version === undefined ? {} : { version: input.version }),
    });
  }

  // --- Backlog (S4-F2) ------------------------------------------------------

  async backlog(query: BacklogQuery, userId: string): Promise<BacklogView> {
    const empty: BacklogView = {
      projectId: query.projectId,
      groupBy: query.groupBy,
      items: [],
      groups: [],
      totals: backlogTotals([]),
      truncated: false,
    };
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return empty;
    }
    const ref = (value: string | undefined): string | null | undefined =>
      value === undefined ? undefined : value === 'none' ? null : value;
    const assigneeId = query.assigneeId === 'me' ? userId : ref(query.assigneeId);
    const releaseId = ref(query.releaseId);
    const where: Prisma.WorkItemWhereInput = {
      projectId,
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      ...(assigneeId === undefined ? {} : { assigneeId }),
      ...(releaseId === undefined ? {} : { releaseId }),
      ...(query.label === undefined ? {} : { labels: { has: query.label } }),
      ...(query.status !== undefined
        ? { status: query.status }
        : query.includeClosed === 'true'
          ? {}
          : { status: { notIn: ['done', 'cancelled'] } }),
      ...(query.search === undefined
        ? {}
        : {
            OR: [
              { title: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
              { key: { contains: query.search.toUpperCase() } },
            ],
          }),
    };
    const rows = await this.items.backlog(where, BACKLOG_MAX_ITEMS + 1);
    const truncated = rows.length > BACKLOG_MAX_ITEMS;
    const items = rows.slice(0, BACKLOG_MAX_ITEMS).map(toWorkItemView);

    return {
      projectId,
      groupBy: query.groupBy,
      items,
      groups: query.groupBy === 'none' ? [] : await this.group(projectId, items, query.groupBy),
      totals: backlogTotals(items),
      truncated,
    };
  }

  /** Groups items under their nearest epic or feature (the item itself counts). */
  private async group(
    projectId: string,
    items: WorkItemView[],
    by: 'epic' | 'feature',
  ): Promise<BacklogGroup[]> {
    const index = new Map((await this.items.hierarchy(projectId)).map((row) => [row.id, row]));
    const groups = new Map<string | null, BacklogGroup & { members: WorkItemView[] }>();
    for (const item of items) {
      let cursor = index.get(item.id) ?? null;
      let depth = 0;
      while (cursor !== null && cursor.type !== by && depth < 8) {
        cursor = cursor.parentId === null ? null : (index.get(cursor.parentId) ?? null);
        depth += 1;
      }
      const owner = cursor !== null && cursor.type === by ? cursor : null;
      const groupId = owner?.id ?? null;
      let group = groups.get(groupId);
      if (group === undefined) {
        group = {
          id: groupId,
          key: owner?.key ?? null,
          title: owner?.title ?? (by === 'epic' ? 'No epic' : 'No feature'),
          itemIds: [],
          totals: backlogTotals([]),
          members: [],
        };
        groups.set(groupId, group);
      }
      group.itemIds.push(item.id);
      group.members.push(item);
    }
    return [...groups.values()].map(({ members, ...group }) => ({
      ...group,
      totals: backlogTotals(members),
    }));
  }

  /** Drag and drop: places the item right before or right after another one. */
  async move(id: string, input: MoveWorkItemInput): Promise<WorkItemView> {
    const item = await this.require(id);
    const anchorId = input.beforeId ?? input.afterId ?? '';
    if (anchorId === id) {
      throw new ValidationError('A work item cannot be placed relative to itself');
    }

    const moved = await this.prisma.runInTransaction(async (tx) => {
      await this.items.lockBacklog(item.projectId, tx);
      const current = await this.items.lock(id, tx);
      const anchor = await this.items.findById(anchorId, tx);
      if (current === null || anchor === null || anchor.projectId !== current.projectId) {
        throw new NotFoundError('Work item');
      }
      const direction = input.beforeId === undefined ? 'below' : 'above';
      let rank = await this.slot(current, anchor, direction, tx);
      if (rank === null) {
        await this.items.renumber(current.projectId, BACKLOG_RANK_STEP, tx);
        const refreshed = await this.items.findById(anchor.id, tx);
        rank = refreshed === null ? null : await this.slot(current, refreshed, direction, tx);
        if (rank === null) {
          throw new ConflictError('The backlog could not be reordered; try again');
        }
      }
      await this.items.setRank(id, rank, tx);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'WorkItem',
          entityId: id,
          summary: `Moved ${current.key} ${direction === 'above' ? 'before' : 'after'} ${anchor.key} in the backlog`,
          changes: { rank: { from: current.rank, to: rank } },
        },
        tx,
      );
      const row = await this.items.findById(id, tx);
      if (row === null) {
        throw new NotFoundError('Work item');
      }
      return row;
    });
    return toWorkItemView(moved);
  }

  /** A free rank between the anchor and its neighbour, or `null` when the gap is exhausted. */
  private async slot(
    item: WorkItem,
    anchor: WorkItem,
    direction: 'above' | 'below',
    tx: PrismaTransaction,
  ): Promise<number | null> {
    const neighbour = await this.items.neighbour(
      item.projectId,
      anchor.rank,
      direction,
      item.id,
      tx,
    );
    if (neighbour === null) {
      return direction === 'above'
        ? anchor.rank - BACKLOG_RANK_STEP
        : anchor.rank + BACKLOG_RANK_STEP;
    }
    const low = Math.min(neighbour.rank, anchor.rank);
    const high = Math.max(neighbour.rank, anchor.rank);
    const middle = Math.floor((low + high) / 2);
    return middle > low && middle < high ? middle : null;
  }

  /** All or nothing: one missing or foreign id refuses the whole batch. */
  async bulkUpdate(input: BulkUpdateWorkItemsInput): Promise<BulkUpdateWorkItemsResult> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    const changes = input.changes;
    await this.assertAssignee(project.id, changes.assigneeId);

    const updated = await this.prisma.runInTransaction(async (tx) => {
      const rows = await this.items.lockMany(project.id, input.ids, tx);
      if (rows.length !== input.ids.length) {
        throw new NotFoundError('Work item');
      }
      if (changes.releaseId !== undefined) {
        if (changes.releaseId !== null) {
          await this.releases.assertAttachable(changes.releaseId, project.id, tx);
        }
        const leaving = new Set(
          rows
            .map((row) => row.releaseId)
            .filter((releaseId): releaseId is string => releaseId !== null)
            .filter((releaseId) => releaseId !== changes.releaseId),
        );
        for (const releaseId of leaving) {
          await this.releases.assertAttachable(releaseId, project.id, tx);
        }
      }

      const removed = new Set(changes.removeLabels ?? []);
      const results: WorkItem[] = [];
      for (const current of rows) {
        const labels =
          changes.addLabels === undefined && changes.removeLabels === undefined
            ? undefined
            : normalizeLabels([...current.labels, ...(changes.addLabels ?? [])]).filter(
                (label) => !removed.has(label),
              );
        if (labels !== undefined && labels.length > 20) {
          throw new ValidationError(`${current.key} would have more than 20 labels`);
        }
        const completedAt =
          changes.status === undefined || changes.status === current.status
            ? undefined
            : isClosedWorkItemStatus(changes.status)
              ? new Date()
              : null;
        const row = await this.items.update(
          current.id,
          {
            ...(changes.status === undefined ? {} : { status: changes.status }),
            ...(changes.priority === undefined ? {} : { priority: changes.priority }),
            ...(changes.assigneeId === undefined ? {} : { assigneeId: changes.assigneeId }),
            ...(changes.releaseId === undefined ? {} : { releaseId: changes.releaseId }),
            ...(changes.estimate === undefined ? {} : { estimate: changes.estimate }),
            ...(labels === undefined ? {} : { labels }),
            ...(completedAt === undefined ? {} : { completedAt }),
          },
          tx,
        );
        if (row === null) {
          throw new NotFoundError('Work item');
        }
        const diffed = diff(current, row);
        await this.audit.record(
          {
            action: AuditAction.update,
            entityType: 'WorkItem',
            entityId: row.id,
            summary: `Bulk updated ${row.key}`,
            ...(Object.keys(diffed).length === 0 ? {} : { changes: diffed }),
          },
          tx,
        );
        results.push(row);
      }
      return results;
    });

    return { updated: updated.map(toWorkItemView) };
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
    // The ranks already bound the depth; this keeps the limit explicit if they change.
    const depth = (await this.items.ancestors(parent)).length + 2;
    if (depth > WORK_ITEM_MAX_DEPTH) {
      throw new ValidationError(`The hierarchy is limited to ${WORK_ITEM_MAX_DEPTH} levels`);
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
    rank: item.rank,
    version: item.version,
    completedAt: item.completedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function childrenIndex(rows: readonly WorkItem[]): Map<string, WorkItem[]> {
  const index = new Map<string, WorkItem[]>();
  for (const row of rows) {
    if (row.parentId !== null) {
      const siblings = index.get(row.parentId) ?? [];
      siblings.push(row);
      index.set(row.parentId, siblings);
    }
  }
  return index;
}
