import { z } from 'zod';

/**
 * Parameterized test cases (S7-F3).
 *
 * The parameters and the dataset belong to the case definition and are
 * versioned with it. A run expands a parameterized case into one execution per
 * dataset row and freezes the resolved values, so editing the dataset later
 * never rewrites what was executed.
 */
export const PARAMETER_TYPES = ['string', 'number', 'boolean', 'date'] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

export const MAX_PARAMETERS = 30;
export const MAX_DATASET_ROWS = 200;
/** CSV columns that are not parameters; parameter names cannot start with `_`. */
export const DATASET_ID_COLUMN = '_id';
export const DATASET_LABEL_COLUMN = '_label';

export type ParameterValue = string | number | boolean;

export const parameterValueSchema = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
]);

export const testParameterSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'Use letters, digits and _; start with a letter'),
  type: z.enum(PARAMETER_TYPES),
  required: z.boolean().default(false),
  defaultValue: parameterValueSchema.nullish(),
  description: z.string().trim().max(500).nullish(),
});
export type TestParameterInput = z.infer<typeof testParameterSchema>;

export const datasetRowSchema = z.object({
  /** Kept across edits so a row keeps its identity; new rows get one. */
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional(),
  label: z.string().trim().min(1).max(120).nullish(),
  values: z.record(z.string(), parameterValueSchema.nullable()).default({}),
});
export type DatasetRowInput = z.infer<typeof datasetRowSchema>;

export interface TestParameterView {
  name: string;
  type: ParameterType;
  required: boolean;
  defaultValue: ParameterValue | null;
  description: string | null;
}

export interface DatasetRowView {
  id: string;
  label: string;
  values: Record<string, ParameterValue | null>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(text: string): boolean {
  if (!DATE.test(text)) {
    return false;
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/** `null` when the value fits the type, otherwise why it does not. */
export function parameterTypeError(type: ParameterType, value: ParameterValue): string | null {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : 'expects text';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'expects a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expects true or false';
    case 'date':
      return typeof value === 'string' && isValidDate(value) ? null : 'expects a YYYY-MM-DD date';
  }
}

/**
 * Every problem of a definition, worded for the editor. Empty means valid:
 * unique names, defaults of the right type, and every row with known columns,
 * values of the right type and every required value present or defaulted.
 */
export function validateParameterDefinition(
  parameters: ReadonlyArray<
    Pick<TestParameterInput, 'name' | 'type' | 'required' | 'defaultValue'>
  >,
  rows: ReadonlyArray<Pick<DatasetRowInput, 'id' | 'label' | 'values'>>,
): string[] {
  const errors: string[] = [];
  const byName = new Map<string, (typeof parameters)[number]>();
  for (const parameter of parameters) {
    const key = parameter.name.toLowerCase();
    if (byName.has(key)) {
      errors.push(`Parameter ${parameter.name} is defined twice`);
    }
    byName.set(key, parameter);
    if (parameter.defaultValue !== undefined && parameter.defaultValue !== null) {
      const problem = parameterTypeError(parameter.type, parameter.defaultValue);
      if (problem !== null) {
        errors.push(`The default of ${parameter.name} ${problem}`);
      }
    }
  }
  if (rows.length > 0 && parameters.length === 0) {
    errors.push('A dataset needs at least one parameter');
  }
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    const where = `Row ${index + 1}${row.label === undefined || row.label === null ? '' : ` (${row.label})`}`;
    if (row.id !== undefined) {
      if (ids.has(row.id)) {
        errors.push(`${where}: duplicate row id ${row.id}`);
      }
      ids.add(row.id);
    }
    for (const [name, value] of Object.entries(row.values)) {
      const parameter = byName.get(name.toLowerCase());
      if (parameter === undefined) {
        errors.push(`${where}: unknown parameter ${name}`);
      } else if (value !== null) {
        const problem = parameterTypeError(parameter.type, value);
        if (problem !== null) {
          errors.push(`${where}: ${parameter.name} ${problem}`);
        }
      }
    }
    for (const parameter of parameters) {
      const value = valueOf(row.values, parameter.name);
      if (
        parameter.required &&
        (value === undefined || value === null || value === '') &&
        (parameter.defaultValue === undefined || parameter.defaultValue === null)
      ) {
        errors.push(`${where}: ${parameter.name} is required`);
      }
    }
  });
  return errors;
}

function valueOf(
  values: Record<string, ParameterValue | null>,
  name: string,
): ParameterValue | null | undefined {
  const key = Object.keys(values).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : values[key];
}

/** The values an execution runs with: the row's, then the defaults, then `null`. */
export function resolveRowValues(
  parameters: ReadonlyArray<Pick<TestParameterView, 'name' | 'defaultValue'>>,
  row: Pick<DatasetRowView, 'values'>,
): Record<string, ParameterValue | null> {
  const resolved: Record<string, ParameterValue | null> = {};
  for (const parameter of parameters) {
    const value = valueOf(row.values, parameter.name);
    resolved[parameter.name] =
      value === undefined || value === null || value === '' ? parameter.defaultValue : value;
  }
  return resolved;
}

/** One CSV cell as a typed value; an empty cell is a missing value. */
export function parseParameterCell(
  type: ParameterType,
  text: string,
): { value: ParameterValue | null } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { value: null };
  }
  switch (type) {
    case 'string':
      return { value: text };
    case 'number': {
      const value = Number(trimmed);
      return Number.isFinite(value) ? { value } : { error: 'expects a number' };
    }
    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (['true', 'yes', '1'].includes(lower)) {
        return { value: true };
      }
      if (['false', 'no', '0'].includes(lower)) {
        return { value: false };
      }
      return { error: 'expects true or false' };
    }
    case 'date':
      return isValidDate(trimmed) ? { value: trimmed } : { error: 'expects a YYYY-MM-DD date' };
  }
}

/** The text a typed value takes in a CSV cell. */
export function formatParameterValue(value: ParameterValue | null): string {
  return value === null ? '' : String(value);
}

export const replaceParametersSchema = z
  .object({
    parameters: z.array(testParameterSchema).max(MAX_PARAMETERS),
    rows: z.array(datasetRowSchema).max(MAX_DATASET_ROWS),
    /** The case version the editor started from; 409 if it moved. */
    version: z.number().int().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    for (const message of validateParameterDefinition(value.parameters, value.rows)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['rows'] });
    }
  });
export type ReplaceParametersInput = z.infer<typeof replaceParametersSchema>;

export const importDatasetSchema = z.object({
  csv: z
    .string()
    .min(1)
    .max(512 * 1024),
  version: z.number().int().min(1).optional(),
});
export type ImportDatasetInput = z.infer<typeof importDatasetSchema>;

/** The dataset row a run case executes, frozen when the run included it. */
export interface RunCaseIterationView {
  rowId: string;
  label: string;
  index: number;
  values: Record<string, ParameterValue | null>;
}
