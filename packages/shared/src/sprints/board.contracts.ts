import { z } from 'zod';
import { PRIORITIES } from '../requirements/requirement.contracts.js';
import { WORK_ITEM_TYPES } from '../work-items/work-item.contracts.js';
import type { WorkItemStatus, WorkItemView } from '../work-items/work-item.contracts.js';
import type { SprintMetrics, SprintView, VelocityView } from './sprint.contracts.js';

/**
 * Scrum board of a sprint (S4-F6). Each column groups one or more work item
 * statuses; dropping a card into a column sets the column's `target` status
 * unless the item already has one of the column's statuses. Cancelled items
 * stay off the board. The order inside a column is the backlog rank.
 */
export const BOARD_COLUMN_IDS = ['todo', 'in_progress', 'blocked', 'in_review', 'done'] as const;
export type BoardColumnId = (typeof BOARD_COLUMN_IDS)[number];

export interface BoardColumnDefinition {
  id: BoardColumnId;
  label: string;
  statuses: readonly WorkItemStatus[];
  target: WorkItemStatus;
}

export const BOARD_COLUMNS: readonly BoardColumnDefinition[] = [
  { id: 'todo', label: 'Backlog / Ready', statuses: ['backlog', 'ready'], target: 'ready' },
  { id: 'in_progress', label: 'In progress', statuses: ['in_progress'], target: 'in_progress' },
  { id: 'blocked', label: 'Blocked', statuses: ['blocked'], target: 'blocked' },
  { id: 'in_review', label: 'In review', statuses: ['in_review'], target: 'in_review' },
  { id: 'done', label: 'Done', statuses: ['done'], target: 'done' },
];

export function columnOf(status: WorkItemStatus): BoardColumnId | null {
  return BOARD_COLUMNS.find((column) => column.statuses.includes(status))?.id ?? null;
}

/** The status an item gets when it lands in a column. */
export function statusForColumn(column: BoardColumnId, current: WorkItemStatus): WorkItemStatus {
  const definition = BOARD_COLUMNS.find((entry) => entry.id === column);
  if (definition === undefined) {
    return current;
  }
  return definition.statuses.includes(current) ? current : definition.target;
}

export const BOARD_SWIMLANES = ['none', 'assignee', 'epic'] as const;
export type BoardSwimlane = (typeof BOARD_SWIMLANES)[number];
export const BOARD_MAX_ITEMS = 500;

const idSchema = z.string().min(1).max(64);

export const boardQuerySchema = z.object({
  projectId: idSchema,
  /** Defaults to the active sprint of the project. */
  sprintId: idSchema.optional(),
  /** A user id, `me` or `none`. */
  assigneeId: idSchema.optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(WORK_ITEM_TYPES).optional(),
  /** An epic or feature id, or `none`. */
  epicId: idSchema.optional(),
  featureId: idSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  swimlane: z.enum(BOARD_SWIMLANES).default('none'),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

export const moveBoardCardSchema = z
  .object({
    workItemId: idSchema,
    column: z.enum(BOARD_COLUMN_IDS),
    /** Place the card right before this card of the sprint … */
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
export type MoveBoardCardInput = z.infer<typeof moveBoardCardSchema>;

export interface BoardRef {
  id: string;
  key: string;
  title: string;
}

export interface BoardCard extends WorkItemView {
  epic: BoardRef | null;
  feature: BoardRef | null;
  assignee: { id: string; fullName: string } | null;
  /** Live requirements this item implements. */
  requirements: { count: number; keys: string[] };
}

export interface BoardColumnView {
  id: BoardColumnId;
  label: string;
  statuses: readonly WorkItemStatus[];
  /** Cards after filters, in rank order. */
  cardIds: string[];
  estimate: number;
}

export interface BoardSwimlaneView {
  /** Assignee or epic id; `null` for "Unassigned" / "No epic". */
  id: string | null;
  title: string;
  cardIds: string[];
}

export interface BoardView {
  projectId: string;
  /** `null` when the project has no active sprint and none was asked for. */
  sprint: SprintView | null;
  /** Metrics of the whole sprint, ignoring filters. */
  metrics: SprintMetrics | null;
  velocity: VelocityView;
  columns: BoardColumnView[];
  cards: BoardCard[];
  swimlane: BoardSwimlane;
  swimlanes: BoardSwimlaneView[];
  /** Epics and features the sprint's items belong to, for the filters. */
  epics: BoardRef[];
  features: BoardRef[];
  /** Cards on the board before filters and how many survived them. */
  total: number;
  shown: number;
  truncated: boolean;
}
