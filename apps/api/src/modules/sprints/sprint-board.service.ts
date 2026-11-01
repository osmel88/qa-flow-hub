import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, SprintStatus, WorkItem } from '@prisma/client';
import {
  BOARD_COLUMNS,
  BOARD_MAX_ITEMS,
  BoardCard,
  BoardColumnId,
  BoardQuery,
  BoardRef,
  BoardSwimlaneView,
  BoardView,
  MoveBoardCardInput,
  WorkItemView,
  columnOf,
  computeSprintMetrics,
  isOpenSprint,
  statusForColumn,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { WorkItemsRepository, WorkItemSummary } from '../work-items/work-items.repository';
import { WorkItemsService, toWorkItemView } from '../work-items/work-items.service';
import { SprintsRepository } from './sprints.repository';
import { SprintsService, toSprintView } from './sprints.service';

/**
 * Scrum board of a sprint (S4-F6). A move changes the status and/or the rank
 * of one card in one transaction. Lock order: backlog advisory lock, sprint
 * (`FOR SHARE`, so it cannot close meanwhile), work item (`FOR UPDATE`).
 */
@Injectable()
export class SprintBoardService {
  constructor(
    private readonly sprints: SprintsRepository,
    private readonly sprintsService: SprintsService,
    private readonly items: WorkItemsRepository,
    private readonly workItems: WorkItemsService,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async board(query: BoardQuery, userId: string): Promise<BoardView> {
    const empty: BoardView = {
      projectId: query.projectId,
      sprint: null,
      metrics: null,
      velocity: { velocity: null, sprints: [] },
      columns: BOARD_COLUMNS.map((column) => ({
        id: column.id,
        label: column.label,
        statuses: column.statuses,
        cardIds: [],
        estimate: 0,
      })),
      cards: [],
      swimlane: query.swimlane,
      swimlanes: [],
      epics: [],
      features: [],
      total: 0,
      shown: 0,
      truncated: false,
    };
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return empty;
    }
    const velocity = await this.sprintsService.velocity(projectId);
    const sprint =
      query.sprintId === undefined
        ? await this.prisma.runInTransaction((tx) => this.sprints.findActive(projectId, tx))
        : await this.sprints.findById(query.sprintId);
    if (sprint === null || sprint.projectId !== projectId) {
      if (query.sprintId !== undefined) {
        throw new NotFoundError('Sprint');
      }
      return { ...empty, projectId, velocity };
    }

    const rows = await this.sprints.items(sprint.id);
    const metrics = computeSprintMetrics(
      rows.map(toWorkItemView),
      sprint.capacity,
      sprint.status === SprintStatus.planned ? null : sprint.committedEstimate,
    );
    if (!isOpenSprint(sprint.status) && sprint.completedEstimate !== null) {
      metrics.completedEstimate = sprint.completedEstimate;
    }
    const onBoard = rows.filter((row) => columnOf(row.status) !== null);
    const truncated = onBoard.length > BOARD_MAX_ITEMS;
    const visible = onBoard.slice(0, BOARD_MAX_ITEMS);

    const index = new Map(
      (await this.items.hierarchy(projectId)).map((row) => [row.id, row] as const),
    );
    const [requirements, names] = await Promise.all([
      this.sprints.requirementKeys(visible.map((row) => row.id)),
      this.sprints.userNames(
        [...new Set(visible.map((row) => row.assigneeId))].filter(
          (id): id is string => id !== null,
        ),
      ),
    ]);
    const cards: BoardCard[] = visible.map((row) => {
      const keys = requirements.get(row.id) ?? [];
      return {
        ...toWorkItemView(row),
        epic: ancestorOf(row, 'epic', index),
        feature: ancestorOf(row, 'feature', index),
        assignee:
          row.assigneeId === null
            ? null
            : { id: row.assigneeId, fullName: names.get(row.assigneeId) ?? 'Unknown user' },
        requirements: { count: keys.length, keys },
      };
    });

    const epics = uniqueRefs(cards.map((card) => card.epic));
    const features = uniqueRefs(cards.map((card) => card.feature));
    const shown = cards.filter((card) => matches(card, query, userId));
    const columns = BOARD_COLUMNS.map((column) => {
      const inColumn = shown.filter((card) => column.statuses.includes(card.status));
      return {
        id: column.id,
        label: column.label,
        statuses: column.statuses,
        cardIds: inColumn.map((card) => card.id),
        estimate: round(inColumn.reduce((sum, card) => sum + (card.estimate ?? 0), 0)),
      };
    });

    return {
      projectId,
      sprint: toSprintView(sprint),
      metrics,
      velocity,
      columns,
      cards: shown,
      swimlane: query.swimlane,
      swimlanes: swimlanes(shown, query.swimlane),
      epics,
      features,
      total: onBoard.length,
      shown: shown.length,
      truncated,
    };
  }

  async move(sprintId: string, input: MoveBoardCardInput): Promise<WorkItemView> {
    const sprint = await this.sprints.findById(sprintId);
    if (sprint === null) {
      throw new NotFoundError('Sprint');
    }
    await this.access.assertRouteAccess(sprint.projectId, 'Sprint');
    const anchorId = input.beforeId ?? input.afterId;
    if (anchorId === input.workItemId) {
      throw new ValidationError('A card cannot be placed relative to itself');
    }

    const moved = await this.prisma.runInTransaction(async (tx) => {
      await this.items.lockBacklog(sprint.projectId, tx);
      const [locked] = await this.sprints.lock([sprint.id], 'share', tx);
      if (locked === undefined) {
        throw new NotFoundError('Sprint');
      }
      if (locked.status !== SprintStatus.active) {
        throw new ConflictError(
          `This sprint is ${locked.status}; only the board of the active sprint can change`,
          { status: locked.status },
        );
      }
      const current = await this.items.lock(input.workItemId, tx);
      if (current === null || current.projectId !== sprint.projectId) {
        throw new NotFoundError('Work item');
      }
      if (current.sprintId !== sprint.id) {
        throw new ConflictError(`${current.key} is no longer in this sprint; reload the board`);
      }
      if (columnOf(current.status) === null) {
        throw new ConflictError(`${current.key} is ${current.status} and is not on the board`);
      }
      if (input.version !== undefined && input.version !== current.version) {
        throw new ConflictError(
          `${current.key} was changed by someone else; reload the board and try again`,
          { version: current.version },
        );
      }

      let rank: number | null = null;
      let anchor: WorkItem | null = null;
      if (anchorId !== undefined) {
        anchor = await this.items.findById(anchorId, tx);
        if (anchor === null || anchor.projectId !== sprint.projectId) {
          throw new NotFoundError('Work item');
        }
        if (anchor.sprintId !== sprint.id || columnOf(anchor.status) !== input.column) {
          throw new ConflictError(`${anchor.key} moved meanwhile; reload the board`);
        }
        rank = await this.workItems.placeRelative(
          current,
          anchor,
          input.beforeId === undefined ? 'below' : 'above',
          tx,
        );
      }

      const status = statusForColumn(input.column, current.status);
      const statusChanged = status !== current.status;
      if (statusChanged) {
        await this.items.update(
          current.id,
          {
            status,
            completedAt: status === 'done' ? new Date() : null,
            ...(rank === null ? {} : { rank }),
          },
          tx,
        );
      } else if (rank !== null) {
        await this.items.setRank(current.id, rank, tx);
      }
      const changes: Record<string, Prisma.InputJsonValue> = {
        column: { from: columnOf(current.status), to: input.column },
      };
      if (statusChanged) {
        changes['status'] = { from: current.status, to: status };
      }
      if (rank !== null) {
        changes['rank'] = { from: current.rank, to: rank };
      }
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'WorkItem',
          entityId: current.id,
          summary: statusChanged
            ? `Moved ${current.key} from ${current.status} to ${status} on the board`
            : `Reordered ${current.key} in ${columnLabel(input.column)} on the board`,
          changes: { ...changes, sprintId: sprint.id },
        },
        tx,
      );
      const row = await this.items.findById(current.id, tx);
      if (row === null) {
        throw new NotFoundError('Work item');
      }
      return row;
    });
    return toWorkItemView(moved);
  }
}

function columnLabel(id: BoardColumnId): string {
  return BOARD_COLUMNS.find((column) => column.id === id)?.label ?? id;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The nearest epic or feature above an item (the item itself counts). */
function ancestorOf(
  item: Pick<WorkItem, 'id'>,
  type: 'epic' | 'feature',
  index: ReadonlyMap<string, WorkItemSummary>,
): BoardRef | null {
  let cursor = index.get(item.id) ?? null;
  let depth = 0;
  while (cursor !== null && cursor.type !== type && depth < 8) {
    cursor = cursor.parentId === null ? null : (index.get(cursor.parentId) ?? null);
    depth += 1;
  }
  return cursor !== null && cursor.type === type
    ? { id: cursor.id, key: cursor.key, title: cursor.title }
    : null;
}

function uniqueRefs(refs: ReadonlyArray<BoardRef | null>): BoardRef[] {
  const seen = new Map<string, BoardRef>();
  for (const ref of refs) {
    if (ref !== null && !seen.has(ref.id)) {
      seen.set(ref.id, ref);
    }
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
}

function matches(card: BoardCard, query: BoardQuery, userId: string): boolean {
  const ref = (value: string | undefined, actual: string | null): boolean =>
    value === undefined || (value === 'none' ? actual === null : actual === value);
  const assignee = query.assigneeId === 'me' ? userId : query.assigneeId;
  if (!ref(assignee, card.assigneeId)) {
    return false;
  }
  if (query.priority !== undefined && card.priority !== query.priority) {
    return false;
  }
  if (query.type !== undefined && card.type !== query.type) {
    return false;
  }
  if (
    !ref(query.epicId, card.epic?.id ?? null) ||
    !ref(query.featureId, card.feature?.id ?? null)
  ) {
    return false;
  }
  if (query.search !== undefined) {
    const needle = query.search.toLowerCase();
    return card.title.toLowerCase().includes(needle) || card.key.toLowerCase().includes(needle);
  }
  return true;
}

function swimlanes(cards: readonly BoardCard[], by: BoardQuery['swimlane']): BoardSwimlaneView[] {
  if (by === 'none') {
    return [];
  }
  const lanes = new Map<string | null, BoardSwimlaneView>();
  for (const card of cards) {
    const owner =
      by === 'assignee'
        ? card.assignee === null
          ? null
          : { id: card.assignee.id, title: card.assignee.fullName }
        : card.epic === null
          ? null
          : { id: card.epic.id, title: `${card.epic.key} ${card.epic.title}` };
    const id = owner?.id ?? null;
    let lane = lanes.get(id);
    if (lane === undefined) {
      lane = {
        id,
        title: owner?.title ?? (by === 'assignee' ? 'Unassigned' : 'No epic'),
        cardIds: [],
      };
      lanes.set(id, lane);
    }
    lane.cardIds.push(card.id);
  }
  const named = [...lanes.values()].filter((lane) => lane.id !== null);
  named.sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true }));
  const rest = lanes.get(null);
  return rest === undefined ? named : [...named, rest];
}
