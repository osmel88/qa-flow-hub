import { z } from 'zod';
import { TEST_CASE_STATUSES } from '../test-design/test-design.contracts.js';

export const exportTestCasesQuerySchema = z.object({
  suiteId: z.string().min(1).optional(),
  sectionId: z.string().min(1).optional(),
  status: z.enum(TEST_CASE_STATUSES).optional(),
  includeArchived: z.enum(['true', 'false']).default('false'),
});
export type ExportTestCasesQuery = z.infer<typeof exportTestCasesQuerySchema>;

export const exportMatrixQuerySchema = z.object({
  projectId: z.string().min(1),
  uncoveredOnly: z.enum(['true', 'false']).default('false'),
});
export type ExportMatrixQuery = z.infer<typeof exportMatrixQuerySchema>;

/**
 * Cells starting with one of these are read as a formula by Excel, LibreOffice
 * and Google Sheets (OWASP "CSV injection"). Exports prefix them with `'`.
 */
export const CSV_FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'] as const;

/** Escapes one cell against formula injection; the importer reverses it. */
export function neutralizeCsvFormula(value: string): string {
  return CSV_FORMULA_TRIGGERS.some((trigger) => value.startsWith(trigger)) ? `'${value}` : value;
}

/** Inverse of `neutralizeCsvFormula`, so an export imports back unchanged. */
export function restoreCsvFormula(value: string): string {
  return value.startsWith("'") &&
    CSV_FORMULA_TRIGGERS.some((trigger) => value.startsWith(trigger, 1))
    ? value.slice(1)
    : value;
}
