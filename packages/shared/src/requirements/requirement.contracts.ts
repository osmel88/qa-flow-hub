import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import {
  CustomFieldValues,
  customFieldFilterQuerySchema,
  customFieldValuesInputSchema,
} from '../customization/custom-field.contracts.js';

export const REQUIREMENT_TYPES = [
  'user_story',
  'functional',
  'non_functional',
  'epic',
  'bug_fix',
] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

export const REQUIREMENT_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'implemented',
  'obsolete',
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

/** Derived from the work items that implement a requirement (S4-F4). */
export const IMPLEMENTATION_STATES = [
  'not_implemented',
  'partially_implemented',
  'implemented',
] as const;
export type ImplementationState = (typeof IMPLEMENTATION_STATES)[number];

export interface RequirementImplementation {
  state: ImplementationState;
  /** Live work items linked as `implements`. */
  workItems: number;
  done: number;
  cancelled: number;
  /** done / (workItems − cancelled), one decimal; null when nothing countable. */
  progress: number | null;
}
export type PriorityValue = (typeof PRIORITIES)[number];

/**
 * Tags are free text on purpose — a controlled vocabulary is a feature with a
 * management UI, and teams label things their own way. They are normalised so
 * that "Login", "login " and "LOGIN" are one tag rather than three.
 */
export const tagsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(32))
  .max(20)
  .transform((tags) => Array.from(new Set(tags)));

export const createRequirementSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(20_000).nullish(),
  acceptanceCriteria: z.string().trim().max(20_000).nullish(),
  type: z.enum(REQUIREMENT_TYPES).default('user_story'),
  priority: z.enum(PRIORITIES).default('medium'),
  tags: tagsSchema.default([]),
  customFields: customFieldValuesInputSchema.default({}),
});
export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;

/**
 * `status` is absent for the same reason it is absent from the project update:
 * moving to `approved` is an approval, and the audit trail should say so.
 * `projectId` is absent because moving a requirement between projects would
 * invalidate its key, its traceability links and its history.
 */
export const updateRequirementSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(20_000).nullish(),
    acceptanceCriteria: z.string().trim().max(20_000).nullish(),
    type: z.enum(REQUIREMENT_TYPES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    tags: tagsSchema.optional(),
    /** Patch semantics: only the listed fields change, `null` clears one. */
    customFields: customFieldValuesInputSchema.optional(),
  })
  // Unknown keys are stripped, so a body of only `status` would arrive empty.
  // Rejecting that is more honest than silently doing nothing and appending a
  // version row that records no change.
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateRequirementInput = z.infer<typeof updateRequirementSchema>;

export const changeRequirementStatusSchema = z.object({
  status: z.enum(REQUIREMENT_STATUSES),
});
export type ChangeRequirementStatusInput = z.infer<typeof changeRequirementStatusSchema>;

export const listRequirementsQuerySchema = paginationQuerySchema
  .extend({
    projectId: z.string().min(1),
    status: z.enum(REQUIREMENT_STATUSES).optional(),
    type: z.enum(REQUIREMENT_TYPES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    tag: z.string().trim().toLowerCase().min(1).max(32).optional(),
    search: z.string().trim().min(1).max(120).optional(),
    implementation: z.enum(IMPLEMENTATION_STATES).optional(),
  })
  .merge(customFieldFilterQuerySchema);
export type ListRequirementsQuery = z.infer<typeof listRequirementsQuerySchema>;

export interface RequirementView {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  type: RequirementType;
  priority: PriorityValue;
  status: RequirementStatus;
  tags: string[];
  customFields: CustomFieldValues;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on list and detail responses (S4-F4). */
  implementation?: RequirementImplementation;
}

export interface RequirementVersionView {
  version: number;
  changedById: string | null;
  changedAt: string;
  snapshot: Record<string, unknown>;
}
