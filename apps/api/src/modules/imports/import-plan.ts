import { createHash } from 'node:crypto';
import {
  AUTOMATION_STATUSES,
  ImportIssue,
  MAX_IMPORT_SECTION_DEPTH,
  PRIORITIES,
  TEST_CASE_STATUSES,
  TEST_CASE_TYPES,
} from '@qa-flow-hub/shared';
import { z } from 'zod';
import { DraftCase, issue } from './parsing/case-draft';

/**
 * The persisted plan of a ready job. It is re-validated with this schema on
 * commit: the column is ours, but trusting a JSON blob blindly is how a bug in
 * one release becomes corrupt data in the next.
 */
const draftCaseSchema = z.object({
  line: z.number().int().min(1),
  ref: z.string().nullable(),
  suiteName: z.string().min(2).max(120).nullable(),
  sectionPath: z.array(z.string().min(1).max(120)).max(MAX_IMPORT_SECTION_DEPTH),
  title: z.string().min(3).max(200),
  normalizedTitle: z.string().min(1),
  type: z.enum(TEST_CASE_TYPES),
  priority: z.enum(PRIORITIES),
  status: z.enum(TEST_CASE_STATUSES),
  automationStatus: z.enum(AUTOMATION_STATUSES),
  estimateMinutes: z.number().int().min(1).max(10_000).nullable(),
  tags: z.array(z.string().min(1).max(32)).max(20),
  references: z.array(z.string().min(1)),
  preconditions: z.string().max(20_000).nullable(),
  description: z.string().max(20_000).nullable(),
  expectedResult: z.string().max(20_000).nullable(),
  steps: z
    .array(
      z.object({
        action: z.string().min(1).max(2000),
        expectedResult: z.string().max(2000).nullable(),
        data: z.string().max(2000).nullable(),
      }),
    )
    .max(100),
});

export const storedPlanSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string().length(64),
  drafts: z.array(draftCaseSchema),
});
export type StoredPlan = z.infer<typeof storedPlanSchema>;

/** Rejects a second case with the same title in the same suite and section of the file. */
export function findInFileDuplicates(
  drafts: DraftCase[],
  defaultSuite: string,
): { unique: DraftCase[]; issues: ImportIssue[] } {
  const seen = new Map<string, number>();
  const unique: DraftCase[] = [];
  const issues: ImportIssue[] = [];
  for (const draft of drafts) {
    const key = [draft.suiteName ?? defaultSuite, ...draft.sectionPath, draft.normalizedTitle].join(
      '\u0000',
    );
    const first = seen.get(key);
    if (first !== undefined) {
      issues.push(
        issue(
          draft.line,
          'title',
          'DUPLICATE_IN_FILE',
          `Same title, suite and section as row ${first}`,
        ),
      );
      continue;
    }
    seen.set(key, draft.line);
    unique.push(draft);
  }
  return { unique, issues };
}

/** Identifies the state a resolution depended on; the commit refuses if it moved. */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sectionKey(suiteName: string, path: readonly string[]): string {
  return [suiteName, ...path].join('\u0000');
}
