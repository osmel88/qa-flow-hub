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
