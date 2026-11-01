import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma, SprintStatus, WorkItem } from '@prisma/client';
import {
  BOARD_COLUMNS,
  BOARD_MAX_ITEMS,
  BoardColumnId,
  BoardQuery,
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
import {
  BoardCardsService,
  buildSwimlanes,
  matchesCard,
  roundEstimate,
  uniqueRefs,
} from '../work-items/board-cards';
import { WorkItemsRepository } from '../work-items/work-items.repository';
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
    private readonly cards: BoardCardsService,
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

    const cards = await this.cards.cards(projectId, visible);

    const epics = uniqueRefs(cards.map((card) => card.epic));
    const features = uniqueRefs(cards.map((card) => card.feature));
    const shown = cards.filter((card) => matchesCard(card, query, userId));
    const columns = BOARD_COLUMNS.map((column) => {
      const inColumn = shown.filter((card) => column.statuses.includes(card.status));
      return {
        id: column.id,
        label: column.label,
        statuses: column.statuses,
        cardIds: inColumn.map((card) => card.id),
        estimate: roundEstimate(inColumn.reduce((sum, card) => sum + (card.estimate ?? 0), 0)),
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
      swimlanes: buildSwimlanes(shown, query.swimlane),
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
