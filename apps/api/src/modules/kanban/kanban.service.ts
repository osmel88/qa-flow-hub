import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, WorkItem, WorkItemStatus } from '@prisma/client';
import {
  KANBAN_COLUMNS,
  KANBAN_MAX_ITEMS,
  KanbanCard,
  KanbanColumnView,
  KanbanQuery,
  KanbanView,
  MoveKanbanCardInput,
  UpdateWipLimitsInput,
  WorkItemView,
  computeFlowMetrics,
  daysBetween,
  kanbanColumnLabel,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import {
  BoardCardsService,
  buildSwimlanes,
  matchesCard,
  roundEstimate,
  uniqueRefs,
} from '../work-items/board-cards';
import { WorkItemsRepository } from '../work-items/work-items.repository';
import { WorkItemsService, toWorkItemView } from '../work-items/work-items.service';
import { KanbanRepository } from './kanban.repository';

const DAY = 86_400_000;

/**
 * Kanban board of a project (S4-F7), with no sprint involved. A move changes
 * the status and/or the rank of one card in one transaction under the
 * project's backlog advisory lock, which also serialises WIP limit checks and
 * WIP limit changes. Lock order: backlog lock, then the work item row.
 */
@Injectable()
export class KanbanService {
  constructor(
    private readonly kanban: KanbanRepository,
    private readonly items: WorkItemsRepository,
    private readonly workItems: WorkItemsService,
    private readonly cards: BoardCardsService,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async board(query: KanbanQuery, userId: string, now = new Date()): Promise<KanbanView> {
    const windowStart = new Date(+now - query.windowDays * DAY);
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return {
        projectId: query.projectId,
        windowDays: query.windowDays,
        columns: KANBAN_COLUMNS.map((column) => ({
          id: column.id,
          label: column.label,
          cardIds: [],
          count: 0,
          wipLimit: null,
          estimate: 0,
        })),
        cards: [],
        swimlane: query.swimlane,
        swimlanes: [],
        epics: [],
        features: [],
        metrics: computeFlowMetrics([], now, query.windowDays),
        total: 0,
        shown: 0,
        truncated: false,
      };
    }

    const [rows, counts, limits, flow] = await Promise.all([
      this.kanban.boardItems(projectId, windowStart, KANBAN_MAX_ITEMS + 1),
      this.kanban.columnCounts(projectId, windowStart),
      this.kanban.wipLimits(projectId),
      this.kanban.flowItems(projectId, windowStart),
    ]);
    const truncated = rows.length > KANBAN_MAX_ITEMS;
    const visible = rows.slice(0, KANBAN_MAX_ITEMS);
    const timing = new Map(visible.map((row) => [row.id, row] as const));
    const cards: KanbanCard[] = (await this.cards.cards(projectId, visible)).map((card) => {
      const row = timing.get(card.id);
      const startedAt = row?.startedAt ?? null;
      const statusChangedAt = row?.statusChangedAt ?? now;
      return {
        ...card,
        startedAt: startedAt?.toISOString() ?? null,
        statusChangedAt: statusChangedAt.toISOString(),
        ageDays: startedAt === null || card.status === 'done' ? null : daysBetween(startedAt, now),
        inStatusDays: daysBetween(statusChangedAt, now),
      };
    });

    const shown = cards.filter((card) => matchesCard(card, query, userId));
    const columns: KanbanColumnView[] = KANBAN_COLUMNS.map((column) => {
      const inColumn = shown.filter((card) => card.status === column.id);
      return {
        id: column.id,
        label: column.label,
        cardIds: inColumn.map((card) => card.id),
        count: counts.get(column.id) ?? 0,
        wipLimit: limits.get(column.id) ?? null,
        estimate: roundEstimate(inColumn.reduce((sum, card) => sum + (card.estimate ?? 0), 0)),
      };
    });

    return {
      projectId,
      windowDays: query.windowDays,
      columns,
      cards: shown,
      swimlane: query.swimlane,
      swimlanes: buildSwimlanes(shown, query.swimlane),
      epics: uniqueRefs(cards.map((card) => card.epic)),
      features: uniqueRefs(cards.map((card) => card.feature)),
      metrics: computeFlowMetrics(
        flow.map((row) => ({
          id: row.id,
          key: row.key,
          title: row.title,
          status: row.status,
          startedAt: row.startedAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
        })),
        now,
        query.windowDays,
      ),
      total: [...counts.values()].reduce((sum, value) => sum + value, 0),
      shown: shown.length,
      truncated,
    };
  }

  async move(input: MoveKanbanCardInput): Promise<WorkItemView> {
    const projectId = await this.access.authorizeProjectScope(input.projectId);
    if (projectId === null) {
      throw new NotFoundError('Work item');
    }
    const anchorId = input.beforeId ?? input.afterId;
    if (anchorId === input.workItemId) {
      throw new ValidationError('A card cannot be placed relative to itself');
    }

    const moved = await this.prisma.runInTransaction(async (tx) => {
      await this.items.lockBacklog(projectId, tx);
      const current = await this.items.lock(input.workItemId, tx);
      if (current === null || current.projectId !== projectId) {
        throw new NotFoundError('Work item');
      }
      if (current.status === WorkItemStatus.cancelled) {
        throw new ConflictError(`${current.key} is cancelled and is not on the board`);
      }
      if (input.version !== undefined && input.version !== current.version) {
        throw new ConflictError(
          `${current.key} was changed by someone else; reload the board and try again`,
          { version: current.version },
        );
      }

      const status = input.column as WorkItemStatus;
      const statusChanged = status !== current.status;
      if (statusChanged) {
        const limit = (await this.kanban.wipLimits(projectId, tx)).get(status);
        if (limit !== undefined) {
          const count = await this.kanban.countInStatus(projectId, status, tx);
          if (count >= limit) {
            throw new ConflictError(
              `${kanbanColumnLabel(input.column)} is at its WIP limit (${count}/${limit})`,
              { column: input.column, wipLimit: limit, count },
            );
          }
        }
      }

      let rank: number | null = null;
      let anchor: WorkItem | null = null;
      if (anchorId !== undefined) {
        anchor = await this.items.findById(anchorId, tx);
        if (anchor === null || anchor.projectId !== projectId) {
          throw new NotFoundError('Work item');
        }
        if (anchor.status !== status) {
          throw new ConflictError(`${anchor.key} moved meanwhile; reload the board`);
        }
        rank = await this.workItems.placeRelative(
          current,
          anchor,
          input.beforeId === undefined ? 'below' : 'above',
          tx,
        );
      }

      if (statusChanged) {
        await this.items.update(
          current.id,
          {
            status,
            completedAt: status === WorkItemStatus.done ? new Date() : null,
            ...(rank === null ? {} : { rank }),
          },
          tx,
        );
      } else if (rank !== null) {
        await this.items.setRank(current.id, rank, tx);
      }
      const changes: Record<string, Prisma.InputJsonValue> = { board: 'kanban' };
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
            ? `Moved ${current.key} from ${current.status} to ${status} on the Kanban board`
            : `Reordered ${current.key} in ${kanbanColumnLabel(input.column)} on the Kanban board`,
          changes,
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

  async setWipLimits(
    input: UpdateWipLimitsInput,
    userId: string,
  ): Promise<KanbanColumnView['wipLimit'][]> {
    const projectId = await this.access.authorizeProjectScope(input.projectId);
    if (projectId === null) {
      throw new NotFoundError('Project');
    }
    return this.prisma.runInTransaction(async (tx) => {
      await this.items.lockBacklog(projectId, tx);
      const before = await this.kanban.wipLimits(projectId, tx);
      const changes: Record<string, Prisma.InputJsonValue> = {};
      for (const entry of input.limits) {
        const status = entry.column as WorkItemStatus;
        const previous = before.get(status) ?? null;
        if (previous !== entry.wipLimit) {
          await this.kanban.setWipLimit(projectId, status, entry.wipLimit, userId, tx);
          changes[entry.column] = { from: previous, to: entry.wipLimit };
        }
      }
      if (Object.keys(changes).length > 0) {
        await this.audit.record(
          {
            action: AuditAction.update,
            entityType: 'Project',
            entityId: projectId,
            summary: 'Changed the Kanban WIP limits',
            changes,
          },
          tx,
        );
      }
      const after = await this.kanban.wipLimits(projectId, tx);
      return KANBAN_COLUMNS.map((column) => after.get(column.id) ?? null);
    });
  }
}
