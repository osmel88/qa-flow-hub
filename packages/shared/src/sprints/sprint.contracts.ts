import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import type { WorkItemStatus, WorkItemView } from '../work-items/work-item.contracts.js';

/**
 * Sprints (S4-F5): time boxes of a project's backlog. planned → active →
 * completed, or planned/active → cancelled. Completed and cancelled are
 * terminal and frozen: their items and metrics no longer change.
 * At most one sprint per project is active at a time.
 */
export const SPRINT_STATUSES = ['planned', 'active', 'completed', 'cancelled'] as const;
export type SprintStatus = (typeof SPRINT_STATUSES)[number];

export const OPEN_SPRINT_STATUSES = ['planned', 'active'] as const;

export const SPRINT_TRANSITIONS: Record<SprintStatus, readonly SprintStatus[]> = {
  planned: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function isOpenSprint(status: SprintStatus): boolean {
  return (OPEN_SPRINT_STATUSES as readonly string[]).includes(status);
}

/** Velocity is the average completed estimate of this many latest completed sprints. */
export const VELOCITY_WINDOW = 3;
export const SPRINT_ASSIGN_MAX_ITEMS = 100;
export const SPRINT_MAX_CAPACITY = 10_000;

const idSchema = z.string().min(1).max(64);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Not a valid date');

const capacitySchema = z
  .number()
  .finite()
  .min(0)
  .max(SPRINT_MAX_CAPACITY)
  .refine((value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-9, {
    message: 'Use at most two decimals',
  });

const sprintFields = {
  name: z.string().trim().min(1).max(120),
  goal: z.string().trim().max(2000).nullish(),
  startDate: isoDate.nullish(),
  endDate: isoDate.nullish(),
  capacity: capacitySchema.nullish(),
};

function datesInOrder(value: {
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
}): boolean {
  return (
    value.startDate === undefined ||
    value.startDate === null ||
    value.endDate === undefined ||
    value.endDate === null ||
    value.startDate <= value.endDate
  );
}

const DATE_ORDER = { message: 'The end date cannot be before the start date', path: ['endDate'] };

export const createSprintSchema = z
  .object({ projectId: idSchema, ...sprintFields })
  .refine(datesInOrder, DATE_ORDER);
export type CreateSprintInput = z.infer<typeof createSprintSchema>;

export const updateSprintSchema = z
  .object({
    name: sprintFields.name.optional(),
    goal: sprintFields.goal,
    startDate: sprintFields.startDate,
    endDate: sprintFields.endDate,
    capacity: sprintFields.capacity,
    version: z.number().int().min(1).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: 'Provide at least one field to update',
  })
  .refine(datesInOrder, DATE_ORDER);
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;

export const listSprintsQuerySchema = paginationQuerySchema.extend({
  projectId: idSchema,
  status: z.enum(SPRINT_STATUSES).optional(),
});
export type ListSprintsQuery = z.infer<typeof listSprintsQuerySchema>;

/** Add items to a sprint (from the backlog or another open sprint) or send them back. */
export const sprintItemsSchema = z.object({
  workItemIds: z
    .array(idSchema)
    .min(1)
    .max(SPRINT_ASSIGN_MAX_ITEMS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Ids must be unique' }),
});
export type SprintItemsInput = z.infer<typeof sprintItemsSchema>;

/**
 * Where the unfinished items of a completed or cancelled sprint go: back to
 * the backlog (default) or into a planned sprint of the same project.
 */
export const closeSprintSchema = z.object({
  carryOverTo: z.union([z.literal('backlog'), idSchema]).default('backlog'),
});
export type CloseSprintInput = z.infer<typeof closeSprintSchema>;

export interface SprintMetrics {
  /** Items in the sprint (frozen at close). */
  count: number;
  byStatus: Record<WorkItemStatus, number>;
  /** Estimate planned when the sprint started; live sum while planned. */
  committedEstimate: number;
  /** Estimate of the items in the sprint now; frozen at close. */
  scopeEstimate: number;
  /** Estimate of the done items. */
  completedEstimate: number;
  unestimated: number;
  capacity: number | null;
  /** scope / capacity, one decimal; null without capacity. */
  load: number | null;
  /** done / (count − cancelled), one decimal. */
  progress: number | null;
}

export interface SprintView {
  id: string;
  projectId: string;
  name: string;
  goal: string | null;
  status: SprintStatus;
  startDate: string | null;
  endDate: string | null;
  capacity: number | null;
  committedEstimate: number | null;
  completedEstimate: number | null;
  startedAt: string | null;
  closedAt: string | null;
  version: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SprintDetailView extends SprintView {
  metrics: SprintMetrics;
  /** The sprint backlog, in backlog order. */
  items: WorkItemView[];
}

export interface VelocityView {
  /** Average completed estimate of the last completed sprints; null without any. */
  velocity: number | null;
  sprints: Array<{
    id: string;
    name: string;
    committedEstimate: number;
    completedEstimate: number;
  }>;
}

export interface SprintListView {
  data: SprintView[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  velocity: VelocityView;
}

export interface CloseSprintResult {
  sprint: SprintView;
  /** Unfinished items moved out of the sprint. */
  carriedOver: number;
  /** `backlog` or the id of the sprint that received the items. */
  carriedTo: string;
}

/** Average over the given completed sprints, two decimals. */
export function computeVelocity(completed: readonly number[]): number | null {
  if (completed.length === 0) {
    return null;
  }
  const sum = completed.reduce((total, value) => total + value, 0);
  return Math.round((sum / completed.length) * 100) / 100;
}

/** Metrics of a set of items; shared by the API and the web. */
export function computeSprintMetrics(
  items: ReadonlyArray<Pick<WorkItemView, 'status' | 'estimate'>>,
  capacity: number | null,
  committed: number | null,
): SprintMetrics {
  const byStatus = Object.fromEntries(
    ['backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'].map(
      (status) => [status, 0],
    ),
  ) as Record<WorkItemStatus, number>;
  let scope = 0;
  let completed = 0;
  let unestimated = 0;
  for (const item of items) {
    byStatus[item.status] += 1;
    if (item.estimate === null) {
      unestimated += 1;
      continue;
    }
    scope += item.estimate;
    if (item.status === 'done') {
      completed += item.estimate;
    }
  }
  const round = (value: number): number => Math.round(value * 100) / 100;
  const countable = items.length - byStatus.cancelled;
  return {
    count: items.length,
    byStatus,
    committedEstimate: round(committed ?? scope),
    scopeEstimate: round(scope),
    completedEstimate: round(completed),
    unestimated,
    capacity,
    load: capacity === null || capacity === 0 ? null : Math.round((scope / capacity) * 1000) / 10,
    progress: countable === 0 ? null : Math.round((byStatus.done / countable) * 1000) / 10,
  };
}
