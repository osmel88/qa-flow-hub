import { z } from 'zod';
import type { DatasetRowView, TestParameterView } from './test-parameters.contracts.js';

/**
 * Test case versioning (S7-F4). A version is an immutable copy of the content
 * that defines what a tester executes. Status, tags, section, estimate and
 * custom fields are bookkeeping: changing them does not create a version.
 */
export const VERSIONED_CASE_FIELDS = [
  'title',
  'description',
  'preconditions',
  'expectedResult',
  'type',
  'priority',
] as const;
export type VersionedCaseField = (typeof VERSIONED_CASE_FIELDS)[number];

export const changeReasonSchema = z.string().trim().min(1).max(500);

export interface VersionStepView {
  position: number;
  action: string;
  expectedResult: string | null;
  data: string | null;
}

export interface TestCaseVersionContent {
  title: string;
  description: string | null;
  preconditions: string | null;
  expectedResult: string | null;
  type: string;
  priority: string;
  steps: VersionStepView[];
  parameters: TestParameterView[];
  dataset: DatasetRowView[];
}

export interface TestCaseVersionSummaryView {
  id: string;
  testCaseId: string;
  version: number;
  current: boolean;
  changeReason: string | null;
  /** Set when the version was created by restoring an older one. */
  restoredFromVersion: number | null;
  author: { id: string; fullName: string } | null;
  createdAt: string;
}

export interface TestCaseVersionView extends TestCaseVersionSummaryView {
  content: TestCaseVersionContent;
}

export const restoreVersionSchema = z.object({
  /** The case version the editor has loaded; a newer one answers 409. */
  version: z.number().int().min(1).optional(),
  reason: changeReasonSchema.optional(),
});
export type RestoreVersionInput = z.infer<typeof restoreVersionSchema>;

export const versionDiffQuerySchema = z.object({
  from: z.coerce.number().int().min(1),
  to: z.coerce.number().int().min(1),
});
export type VersionDiffQuery = z.infer<typeof versionDiffQuerySchema>;

export interface FieldChange {
  field: VersionedCaseField;
  before: string | null;
  after: string | null;
}

export interface StepChange {
  position: number;
  change: 'added' | 'removed' | 'changed';
  before: VersionStepView | null;
  after: VersionStepView | null;
}

export interface ParameterChange {
  name: string;
  change: 'added' | 'removed' | 'changed';
  before: TestParameterView | null;
  after: TestParameterView | null;
}

export interface VersionDiffView {
  testCaseId: string;
  from: number;
  to: number;
  fields: FieldChange[];
  steps: StepChange[];
  parameters: ParameterChange[];
  dataset: { before: number; after: number; changed: boolean };
  identical: boolean;
}

const sameStep = (a: VersionStepView, b: VersionStepView) =>
  a.action === b.action && a.expectedResult === b.expectedResult && a.data === b.data;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Field-, step- and parameter-level differences between two versions. */
export function diffVersionContent(
  before: TestCaseVersionContent,
  after: TestCaseVersionContent,
): Omit<VersionDiffView, 'testCaseId' | 'from' | 'to'> {
  const fields: FieldChange[] = VERSIONED_CASE_FIELDS.filter(
    (field) => before[field] !== after[field],
  ).map((field) => ({ field, before: before[field], after: after[field] }));

  const steps: StepChange[] = [];
  const length = Math.max(before.steps.length, after.steps.length);
  for (let index = 0; index < length; index += 1) {
    const old = before.steps[index] ?? null;
    const next = after.steps[index] ?? null;
    if (old === null && next !== null) {
      steps.push({ position: index + 1, change: 'added', before: null, after: next });
    } else if (old !== null && next === null) {
      steps.push({ position: index + 1, change: 'removed', before: old, after: null });
    } else if (old !== null && next !== null && !sameStep(old, next)) {
      steps.push({ position: index + 1, change: 'changed', before: old, after: next });
    }
  }

  const parameters: ParameterChange[] = [];
  const oldByName = new Map(before.parameters.map((p) => [p.name, p]));
  const newByName = new Map(after.parameters.map((p) => [p.name, p]));
  for (const [name, old] of oldByName) {
    const next = newByName.get(name) ?? null;
    if (next === null) {
      parameters.push({ name, change: 'removed', before: old, after: null });
    } else if (!sameJson(old, next)) {
      parameters.push({ name, change: 'changed', before: old, after: next });
    }
  }
  for (const [name, next] of newByName) {
    if (!oldByName.has(name)) {
      parameters.push({ name, change: 'added', before: null, after: next });
    }
  }

  const dataset = {
    before: before.dataset.length,
    after: after.dataset.length,
    changed: !sameJson(before.dataset, after.dataset),
  };

  return {
    fields,
    steps,
    parameters,
    dataset,
    identical:
      fields.length === 0 && steps.length === 0 && parameters.length === 0 && !dataset.changed,
  };
}
