import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import { PRIORITIES } from '../requirements/requirement.contracts.js';

/**
 * Work items (S4-F1): the backlog of a project, from epics down to tasks.
 * Bugs here are development work; QA defects stay in `defects`.
 */
export const WORK_ITEM_TYPES = [
  'epic',
  'feature',
  'story',
  'task',
  'bug',
  'improvement',
  'spike',
] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const WORK_ITEM_STATUSES = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/** Statuses that take an item off the team's plate. */
export const CLOSED_WORK_ITEM_STATUSES = ['done', 'cancelled'] as const;

export function isClosedWorkItemStatus(status: WorkItemStatus): boolean {
  return (CLOSED_WORK_ITEM_STATUSES as readonly string[]).includes(status);
}

/**
 * The hierarchy is ranked: a parent must rank strictly above its children.
 * Epic → Feature → Story/Bug/Improvement/Spike → Task. Because the rank always
 * grows downwards, a cycle is impossible and the depth is at most four.
 */
export const WORK_ITEM_TYPE_RANK: Record<WorkItemType, number> = {
  epic: 0,
  feature: 1,
  story: 2,
  bug: 2,
  improvement: 2,
  spike: 2,
  task: 3,
};

export function canBeParentOf(parent: WorkItemType, child: WorkItemType): boolean {
  return WORK_ITEM_TYPE_RANK[parent] < WORK_ITEM_TYPE_RANK[child];
}

export const WORK_ITEM_LIMITS = {
  titleLength: 200,
  descriptionLength: 20_000,
  labels: 20,
  labelLength: 40,
  maxEstimate: 1000,
} as const;

const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]*$/u;

/** Labels are compared and stored in lower case, NFC, trimmed and without duplicates. */
export function normalizeLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.normalize('NFC').trim().toLowerCase()))];
}

// NFC before the pattern: a decomposed "é" (macOS input) is a letter plus a
// combining mark, and must not be refused for being written differently.
const labelSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(WORK_ITEM_LIMITS.labelLength)
      .regex(LABEL_PATTERN, 'Letters, digits, spaces and . _ : / - only'),
  );

const labelsSchema = z
  .array(labelSchema)
  .max(WORK_ITEM_LIMITS.labels)
  .transform((labels) => normalizeLabels(labels));

/** Points or hours, the team decides; two decimals at most. */
const estimateSchema = z
  .number()
  .finite()
  .min(0)
  .max(WORK_ITEM_LIMITS.maxEstimate)
  .refine((value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-9, {
    message: 'Use at most two decimals',
  });

const titleSchema = z.string().trim().min(3).max(WORK_ITEM_LIMITS.titleLength);
const descriptionSchema = z.string().trim().max(WORK_ITEM_LIMITS.descriptionLength).nullish();
const idSchema = z.string().min(1).max(64);

export const createWorkItemSchema = z.object({
  projectId: idSchema,
  title: titleSchema,
  description: descriptionSchema,
  type: z.enum(WORK_ITEM_TYPES).default('story'),
  status: z.enum(WORK_ITEM_STATUSES).default('backlog'),
  priority: z.enum(PRIORITIES).default('medium'),
  assigneeId: idSchema.nullish(),
  estimate: estimateSchema.nullish(),
  labels: labelsSchema.default([]),
  parentId: idSchema.nullish(),
  releaseId: idSchema.nullish(),
});
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;

export const updateWorkItemSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema,
    type: z.enum(WORK_ITEM_TYPES).optional(),
    status: z.enum(WORK_ITEM_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigneeId: idSchema.nullish(),
    estimate: estimateSchema.nullish(),
    labels: labelsSchema.optional(),
    parentId: idSchema.nullish(),
    releaseId: idSchema.nullish(),
    /**
     * The `version` the client read. When given, the update only applies if
     * nobody changed the item since (409 otherwise).
     */
    version: z.number().int().min(1).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: 'Provide at least one field to update',
  });
export type UpdateWorkItemInput = z.infer<typeof updateWorkItemSchema>;

/** `none` filters items without an assignee, parent or release. */
const refFilter = z.union([z.literal('none'), idSchema]);

export const listWorkItemsQuerySchema = paginationQuerySchema.extend({
  projectId: idSchema,
  type: z.enum(WORK_ITEM_TYPES).optional(),
  status: z.enum(WORK_ITEM_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: refFilter.optional(),
  reporterId: idSchema.optional(),
  parentId: refFilter.optional(),
  releaseId: refFilter.optional(),
  label: labelSchema.transform((label) => normalizeLabels([label])[0] ?? label).optional(),
  open: z.enum(['true', 'false']).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListWorkItemsQuery = z.infer<typeof listWorkItemsQuerySchema>;

export interface WorkItemView {
  id: string;
  projectId: string;
  /** Human-readable and stable: WEB-W-12. */
  key: string;
  title: string;
  description: string | null;
  type: WorkItemType;
  status: WorkItemStatus;
  priority: string;
  assigneeId: string | null;
  reporterId: string | null;
  estimate: number | null;
  labels: string[];
  parentId: string | null;
  releaseId: string | null;
  /** Position in the project backlog, ascending. */
  rank: number;
  /** Bumped by every change; send it back to update without overwriting others. */
  version: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A work item with its direct children and its ancestors (root first). */
export interface WorkItemDetailView extends WorkItemView {
  ancestors: Array<Pick<WorkItemView, 'id' | 'key' | 'title' | 'type'>>;
  children: Array<Pick<WorkItemView, 'id' | 'key' | 'title' | 'type' | 'status'>>;
}

// ---------------------------------------------------------------------------
// Backlog (S4-F2)
// ---------------------------------------------------------------------------

/** Ranks are gapped so that a move rewrites one row. */
export const BACKLOG_RANK_STEP = 1024;
/** The backlog is one ordered list; past this size it is truncated. */
export const BACKLOG_MAX_ITEMS = 500;
export const BULK_MAX_ITEMS = 100;

export const BACKLOG_GROUPINGS = ['none', 'epic', 'feature'] as const;
export type BacklogGrouping = (typeof BACKLOG_GROUPINGS)[number];

export const backlogQuerySchema = z.object({
  projectId: idSchema,
  /** `me` is the personal backlog of the caller. */
  assigneeId: z.union([z.literal('me'), z.literal('none'), idSchema]).optional(),
  releaseId: refFilter.optional(),
  type: z.enum(WORK_ITEM_TYPES).optional(),
  status: z.enum(WORK_ITEM_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  label: labelSchema.transform((label) => normalizeLabels([label])[0] ?? label).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  /** Done and cancelled items are hidden unless asked for. */
  includeClosed: z.enum(['true', 'false']).default('false'),
  groupBy: z.enum(BACKLOG_GROUPINGS).default('none'),
});
export type BacklogQuery = z.infer<typeof backlogQuerySchema>;

export interface BacklogTotals {
  count: number;
  /** Sum of the estimates that exist. */
  estimate: number;
  unestimated: number;
}

export interface BacklogGroup {
  /** The epic or feature, or `null` for items outside any. */
  id: string | null;
  key: string | null;
  title: string;
  itemIds: string[];
  totals: BacklogTotals;
}

export interface BacklogView {
  projectId: string;
  groupBy: BacklogGrouping;
  /** Ordered by rank. */
  items: WorkItemView[];
  /** In order of their first item; empty when `groupBy` is `none`. */
  groups: BacklogGroup[];
  totals: BacklogTotals;
  truncated: boolean;
}

/**
 * Drag and drop: place the item right before `beforeId` or right after
 * `afterId` (exactly one), both items of the same project.
 */
export const moveWorkItemSchema = z
  .object({
    beforeId: idSchema.optional(),
    afterId: idSchema.optional(),
  })
  .refine((value) => (value.beforeId === undefined) !== (value.afterId === undefined), {
    message: 'Give exactly one of beforeId or afterId',
  });
export type MoveWorkItemInput = z.infer<typeof moveWorkItemSchema>;

export const bulkUpdateWorkItemsSchema = z.object({
  projectId: idSchema,
  ids: z
    .array(idSchema)
    .min(1)
    .max(BULK_MAX_ITEMS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Ids must be unique' }),
  changes: z
    .object({
      status: z.enum(WORK_ITEM_STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      assigneeId: idSchema.nullish(),
      releaseId: idSchema.nullish(),
      estimate: estimateSchema.nullish(),
      addLabels: labelsSchema.optional(),
      removeLabels: labelsSchema.optional(),
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: 'Provide at least one change',
    }),
});
export type BulkUpdateWorkItemsInput = z.infer<typeof bulkUpdateWorkItemsSchema>;

export interface BulkUpdateWorkItemsResult {
  updated: WorkItemView[];
}

/** Totals of a set of items, shared by the API and the web. */
export function backlogTotals(items: ReadonlyArray<Pick<WorkItemView, 'estimate'>>): BacklogTotals {
  let estimate = 0;
  let unestimated = 0;
  for (const item of items) {
    if (item.estimate === null) {
      unestimated += 1;
    } else {
      estimate += item.estimate;
    }
  }
  return { count: items.length, estimate: Math.round(estimate * 100) / 100, unestimated };
}
