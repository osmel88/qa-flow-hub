import { z } from 'zod';
import { developmentStatusFilterSchema } from '../development/development.contracts.js';
import { PRIORITIES } from '../requirements/requirement.contracts.js';
import { WORK_ITEM_TYPES } from '../work-items/work-item.contracts.js';
import type { WorkItemStatus } from '../work-items/work-item.contracts.js';
import type { BoardCard, BoardRef, BoardSwimlaneView } from '../sprints/board.contracts.js';
import { BOARD_SWIMLANES } from '../sprints/board.contracts.js';
import type { BoardSwimlane } from '../sprints/board.contracts.js';

/**
 * Kanban board of a project (S4-F7), independent from sprints: one column per
 * work item status (cancelled items stay off the board), optional WIP limits
 * per column and flow metrics (cycle time, throughput, aging).
 */
export const KANBAN_COLUMNS = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'in_review', label: 'In review' },
  { id: 'done', label: 'Done' },
] as const satisfies ReadonlyArray<{ id: WorkItemStatus; label: string }>;

export const KANBAN_COLUMN_IDS = KANBAN_COLUMNS.map((column) => column.id) as [
  KanbanColumnId,
  ...KanbanColumnId[],
];
export type KanbanColumnId = (typeof KANBAN_COLUMNS)[number]['id'];

/** Columns that may carry a WIP limit: everything but Done. */
export const WIP_LIMITED_COLUMNS = KANBAN_COLUMN_IDS.filter(
  (id): id is Exclude<KanbanColumnId, 'done'> => id !== 'done',
);
/** Statuses counted as work in progress for aging. */
export const IN_FLIGHT_STATUSES: readonly WorkItemStatus[] = [
  'in_progress',
  'blocked',
  'in_review',
];

export const KANBAN_MAX_ITEMS = 500;
export const KANBAN_WINDOW_DAYS_DEFAULT = 14;
export const WIP_LIMIT_MAX = 999;

export function kanbanColumnLabel(id: KanbanColumnId): string {
  return KANBAN_COLUMNS.find((column) => column.id === id)?.label ?? id;
}

const idSchema = z.string().min(1).max(64);

export const kanbanQuerySchema = z.object({
  projectId: idSchema,
  /** A user id, `me` or `none`. */
  assigneeId: idSchema.optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(WORK_ITEM_TYPES).optional(),
  /** An epic, feature or release id, or `none`. */
  epicId: idSchema.optional(),
  featureId: idSchema.optional(),
  releaseId: idSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  swimlane: z.enum(BOARD_SWIMLANES).default('none'),
  developmentStatus: developmentStatusFilterSchema.optional(),
  /** Done column and flow metrics cover the last `windowDays` days. */
  windowDays: z.coerce.number().int().min(7).max(90).default(KANBAN_WINDOW_DAYS_DEFAULT),
});
export type KanbanQuery = z.infer<typeof kanbanQuerySchema>;

export const moveKanbanCardSchema = z
  .object({
    projectId: idSchema,
    workItemId: idSchema,
    column: z.enum(KANBAN_COLUMN_IDS),
    /** Place the card right before this card of the target column … */
    beforeId: idSchema.optional(),
    /** … or right after it; neither keeps the current rank. */
    afterId: idSchema.optional(),
    /** The `version` the client saw; 409 when the item changed meanwhile. */
    version: z.number().int().positive().optional(),
  })
  .refine((value) => value.beforeId === undefined || value.afterId === undefined, {
    message: 'Give beforeId or afterId, not both',
    path: ['afterId'],
  });
export type MoveKanbanCardInput = z.infer<typeof moveKanbanCardSchema>;

export const updateWipLimitsSchema = z.object({
  projectId: idSchema,
  limits: z
    .array(
      z.object({
        column: z
          .enum(WIP_LIMITED_COLUMNS as [string, ...string[]])
          .transform((value) => value as Exclude<KanbanColumnId, 'done'>),
        /** `null` removes the limit. */
        wipLimit: z.number().int().min(1).max(WIP_LIMIT_MAX).nullable(),
      }),
    )
    .min(1)
    .max(WIP_LIMITED_COLUMNS.length)
    .refine((limits) => new Set(limits.map((entry) => entry.column)).size === limits.length, {
      message: 'Each column at most once',
    }),
});
export type UpdateWipLimitsInput = z.infer<typeof updateWipLimitsSchema>;

export interface KanbanCard extends BoardCard {
  startedAt: string | null;
  statusChangedAt: string;
  /** Days since the item started; `null` when not started or done. */
  ageDays: number | null;
  /** Days in the current status (column). */
  inStatusDays: number;
}

export interface KanbanColumnView {
  id: KanbanColumnId;
  label: string;
  /** Cards after filters, in rank order. */
  cardIds: string[];
  /** Every item in the column, ignoring filters: what the WIP limit counts. */
  count: number;
  wipLimit: number | null;
  estimate: number;
}

export interface FlowItem {
  id: string;
  key: string;
  title: string;
  status: WorkItemStatus;
  startedAt: string | null;
  completedAt: string | null;
}

export interface FlowMetrics {
  windowDays: number;
  /** Done items completed in the window, oldest week first. */
  throughput: { total: number; weeks: Array<{ from: string; to: string; count: number }> };
  /** Start → done of the items completed in the window that have a start. */
  cycleTime: {
    count: number;
    averageDays: number | null;
    medianDays: number | null;
    p85Days: number | null;
  };
  /** Items in progress, blocked or in review. */
  aging: {
    count: number;
    averageDays: number | null;
    oldest: Array<{ id: string; key: string; title: string; ageDays: number }>;
  };
}

export interface KanbanView {
  projectId: string;
  windowDays: number;
  columns: KanbanColumnView[];
  cards: KanbanCard[];
  swimlane: BoardSwimlane;
  swimlanes: BoardSwimlaneView[];
  epics: BoardRef[];
  features: BoardRef[];
  /** Flow metrics of the whole project, ignoring filters. */
  metrics: FlowMetrics;
  total: number;
  shown: number;
  truncated: boolean;
}

const DAY = 86_400_000;

export function daysBetween(from: Date | string, to: Date | string): number {
  return Math.max(0, Math.round(((+new Date(to) - +new Date(from)) / DAY) * 10) / 10);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function computeFlowMetrics(
  items: readonly FlowItem[],
  now: Date,
  windowDays: number,
): FlowMetrics {
  const windowStart = new Date(+now - windowDays * DAY);
  const done = items.filter(
    (item) =>
      item.status === 'done' &&
      item.completedAt !== null &&
      new Date(item.completedAt) >= windowStart,
  );

  const weeks: FlowMetrics['throughput']['weeks'] = [];
  const count = Math.ceil(windowDays / 7);
  for (let index = count - 1; index >= 0; index -= 1) {
    const to = new Date(+now - index * 7 * DAY);
    const from = new Date(Math.max(+windowStart, +to - 7 * DAY));
    weeks.push({
      from: from.toISOString(),
      to: to.toISOString(),
      count: done.filter((item) => {
        const at = new Date(item.completedAt ?? 0);
        return at > from && at <= to;
      }).length,
    });
  }
  // An item completed exactly at the window start belongs to the oldest week.
  const first = weeks[0];
  if (first !== undefined) {
    first.count += done.filter((item) => +new Date(item.completedAt ?? 0) === +windowStart).length;
  }

  const cycles = done
    .flatMap((item) =>
      item.startedAt === null || item.completedAt === null
        ? []
        : [daysBetween(item.startedAt, item.completedAt)],
    )
    .sort((a, b) => a - b);
  const ages = items
    .filter((item) => IN_FLIGHT_STATUSES.includes(item.status) && item.startedAt !== null)
    .map((item) => ({
      id: item.id,
      key: item.key,
      title: item.title,
      ageDays: daysBetween(item.startedAt ?? now.toISOString(), now),
    }))
    .sort((a, b) => b.ageDays - a.ageDays || a.key.localeCompare(b.key, 'en', { numeric: true }));
  const average = (values: readonly number[]): number | null =>
    values.length === 0
      ? null
      : round(values.reduce((sum, value) => sum + value, 0) / values.length);

  return {
    windowDays,
    throughput: { total: done.length, weeks },
    cycleTime: {
      count: cycles.length,
      averageDays: average(cycles),
      medianDays: percentile(cycles, 50),
      p85Days: percentile(cycles, 85),
    },
    aging: {
      count: ages.length,
      averageDays: average(ages.map((entry) => entry.ageDays)),
      oldest: ages.slice(0, 5),
    },
  };
}

/** Whether a column can take one more card. */
export function wipState(count: number, wipLimit: number | null): 'open' | 'full' | 'over' {
  if (wipLimit === null || count < wipLimit) {
    return 'open';
  }
  return count === wipLimit ? 'full' : 'over';
}
