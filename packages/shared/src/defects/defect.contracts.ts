import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import { PRIORITIES } from '../requirements/requirement.contracts.js';

export const DEFECT_SEVERITIES = ['blocker', 'critical', 'major', 'minor', 'trivial'] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];

export const DEFECT_STATUSES = [
  'open',
  'triaged',
  'in_progress',
  'resolved',
  'closed',
  'rejected',
  'reopened',
] as const;
export type DefectStatus = (typeof DEFECT_STATUSES)[number];

/** Statuses that mean "this defect no longer counts as outstanding". */
export const CLOSED_DEFECT_STATUSES = ['closed', 'rejected'] as const;

export const createDefectSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(20_000).nullish(),
  stepsToReproduce: z.string().trim().max(20_000).nullish(),
  severity: z.enum(DEFECT_SEVERITIES).default('major'),
  priority: z.enum(PRIORITIES).default('medium'),
  environment: z.string().trim().max(120).nullish(),
  assigneeId: z.string().min(1).nullish(),
  /**
   * Where the defect came from. Given a result, the case and the run are
   * derived from it rather than trusted from the client.
   */
  testResultId: z.string().min(1).nullish(),
  requirementIds: z.array(z.string().min(1)).max(20).default([]),
});
export type CreateDefectInput = z.infer<typeof createDefectSchema>;

export const updateDefectSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(20_000).nullish(),
    stepsToReproduce: z.string().trim().max(20_000).nullish(),
    severity: z.enum(DEFECT_SEVERITIES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    environment: z.string().trim().max(120).nullish(),
    assigneeId: z.string().min(1).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateDefectInput = z.infer<typeof updateDefectSchema>;

export const changeDefectStatusSchema = z.object({
  status: z.enum(DEFECT_STATUSES),
  comment: z.string().trim().max(2000).nullish(),
});
export type ChangeDefectStatusInput = z.infer<typeof changeDefectStatusSchema>;

export const listDefectsQuerySchema = paginationQuerySchema.extend({
  projectId: z.string().min(1),
  status: z.enum(DEFECT_STATUSES).optional(),
  severity: z.enum(DEFECT_SEVERITIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.string().min(1).optional(),
  testRunId: z.string().min(1).optional(),
  open: z.enum(['true', 'false']).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListDefectsQuery = z.infer<typeof listDefectsQuerySchema>;

export interface DefectView {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: string | null;
  stepsToReproduce: string | null;
  severity: DefectSeverity;
  priority: string;
  status: DefectStatus;
  environment: string | null;
  testResultId: string | null;
  testCaseId: string | null;
  testRunId: string | null;
  reportedById: string | null;
  assigneeId: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
