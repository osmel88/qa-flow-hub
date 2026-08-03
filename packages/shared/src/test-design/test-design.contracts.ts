import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import { PRIORITIES, tagsSchema } from '../requirements/requirement.contracts.js';

export const TEST_CASE_TYPES = [
  'functional',
  'regression',
  'smoke',
  'integration',
  'performance',
  'security',
  'usability',
  'exploratory',
] as const;
export type TestCaseType = (typeof TEST_CASE_TYPES)[number];

export const TEST_CASE_STATUSES = ['draft', 'active', 'deprecated'] as const;
export type TestCaseStatus = (typeof TEST_CASE_STATUSES)[number];

export const AUTOMATION_STATUSES = ['manual', 'candidate', 'automated'] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

// --- Suites ----------------------------------------------------------------

export const createSuiteSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).nullish(),
});
export type CreateSuiteInput = z.infer<typeof createSuiteSchema>;

export const updateSuiteSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(2000).nullish(),
    position: z.number().int().min(0).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateSuiteInput = z.infer<typeof updateSuiteSchema>;

export interface SuiteView {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  position: number;
  caseCount: number;
  createdAt: string;
  updatedAt: string;
}

// --- Sections --------------------------------------------------------------

export const createSectionSchema = z.object({
  suiteId: z.string().min(1),
  parentId: z.string().min(1).nullish(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullish(),
});
export type CreateSectionInput = z.infer<typeof createSectionSchema>;

export const updateSectionSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullish(),
    /**
     * Reparenting is allowed, but `null` (move to the root) has to be
     * distinguishable from "not provided", which is why this is nullish and the
     * service checks for `undefined` rather than falsiness.
     */
    parentId: z.string().min(1).nullish(),
    position: z.number().int().min(0).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;

export interface SectionView {
  id: string;
  suiteId: string;
  parentId: string | null;
  name: string;
  description: string | null;
  position: number;
  children: SectionView[];
}

// --- Steps -----------------------------------------------------------------

/**
 * Steps are edited as a whole ordered list, not one by one. Positions are
 * derived from array order, so the client cannot produce gaps or duplicates and
 * there is no reordering endpoint to keep consistent.
 */
export const testStepSchema = z.object({
  action: z.string().trim().min(1).max(2000),
  expectedResult: z.string().trim().max(2000).nullish(),
  data: z.string().trim().max(2000).nullish(),
});
export type TestStepInput = z.infer<typeof testStepSchema>;

export const replaceStepsSchema = z.object({
  steps: z.array(testStepSchema).max(100),
});
export type ReplaceStepsInput = z.infer<typeof replaceStepsSchema>;

export interface TestStepView {
  id: string;
  position: number;
  action: string;
  expectedResult: string | null;
  data: string | null;
}

// --- Cases -----------------------------------------------------------------

export const createTestCaseSchema = z.object({
  suiteId: z.string().min(1),
  sectionId: z.string().min(1).nullish(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(20_000).nullish(),
  preconditions: z.string().trim().max(20_000).nullish(),
  expectedResult: z.string().trim().max(20_000).nullish(),
  type: z.enum(TEST_CASE_TYPES).default('functional'),
  priority: z.enum(PRIORITIES).default('medium'),
  automationStatus: z.enum(AUTOMATION_STATUSES).default('manual'),
  estimateMinutes: z.number().int().min(1).max(10_000).nullish(),
  tags: tagsSchema.default([]),
  steps: z.array(testStepSchema).max(100).default([]),
});
export type CreateTestCaseInput = z.infer<typeof createTestCaseSchema>;

export const updateTestCaseSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(20_000).nullish(),
    preconditions: z.string().trim().max(20_000).nullish(),
    expectedResult: z.string().trim().max(20_000).nullish(),
    type: z.enum(TEST_CASE_TYPES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    status: z.enum(TEST_CASE_STATUSES).optional(),
    automationStatus: z.enum(AUTOMATION_STATUSES).optional(),
    estimateMinutes: z.number().int().min(1).max(10_000).nullish(),
    tags: tagsSchema.optional(),
    sectionId: z.string().min(1).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateTestCaseInput = z.infer<typeof updateTestCaseSchema>;

export const duplicateTestCaseSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  sectionId: z.string().min(1).nullish(),
});
export type DuplicateTestCaseInput = z.infer<typeof duplicateTestCaseSchema>;

export const listTestCasesQuerySchema = paginationQuerySchema.extend({
  projectId: z.string().min(1),
  suiteId: z.string().min(1).optional(),
  sectionId: z.string().min(1).optional(),
  status: z.enum(TEST_CASE_STATUSES).optional(),
  type: z.enum(TEST_CASE_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  automationStatus: z.enum(AUTOMATION_STATUSES).optional(),
  tag: z.string().trim().toLowerCase().min(1).max(32).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  /**
   * Query strings have no booleans. Kept as a literal union instead of a
   * transform so the schema's input and output types stay identical, which is
   * what lets the same schema be reused on the client.
   */
  includeArchived: z.enum(['true', 'false']).default('false'),
});
export type ListTestCasesQuery = z.infer<typeof listTestCasesQuerySchema>;

export interface TestCaseView {
  id: string;
  projectId: string;
  suiteId: string;
  sectionId: string | null;
  key: string;
  title: string;
  description: string | null;
  preconditions: string | null;
  expectedResult: string | null;
  type: TestCaseType;
  priority: (typeof PRIORITIES)[number];
  status: TestCaseStatus;
  automationStatus: AutomationStatus;
  estimateMinutes: number | null;
  tags: string[];
  version: number;
  archivedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TestCaseDetailView extends TestCaseView {
  steps: TestStepView[];
}
