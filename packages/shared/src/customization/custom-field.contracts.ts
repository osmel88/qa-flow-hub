import { z } from 'zod';

/**
 * Custom fields and the configurable defect workflow (S3-F7).
 *
 * A custom field is defined once per project and entity type. Values live in a
 * `customFields` JSONB column of the entity, keyed by the definition id rather
 * than by its key, so relabelling a field never rewrites data. Definitions are
 * archived, never deleted: a value written under a definition keeps meaning
 * what it meant.
 */
export const CUSTOM_FIELD_ENTITIES = ['requirement', 'test_case', 'defect'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'multi_select',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_LIMITS = {
  definitionsPerEntity: 50,
  optionsPerField: 100,
  textLength: 2000,
  multiSelectValues: 50,
  /** Absolute bound for numbers, inside the range a double represents exactly. */
  numberMagnitude: 1e12,
} as const;

const customFieldKeySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{0,39}$/,
    'Use 1–40 lowercase letters, digits or underscores, starting with a letter',
  );

const optionLabelSchema = z.string().trim().min(1).max(80);

export const customFieldOptionInputSchema = z.object({
  /** Present for an existing option (rename/archive), absent for a new one. */
  id: z.string().min(1).max(40).optional(),
  label: optionLabelSchema,
  archived: z.boolean().default(false),
});
export type CustomFieldOptionInput = z.infer<typeof customFieldOptionInputSchema>;

function uniqueLabels(
  options: readonly { label: string; archived?: boolean }[] | undefined,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, option] of (options ?? []).entries()) {
    const label = option.label.toLocaleLowerCase('en');
    if (seen.has(label)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', index, 'label'],
        message: `Duplicate option ${option.label}`,
      });
    }
    seen.add(label);
  }
}

export const createCustomFieldSchema = z
  .object({
    projectId: z.string().min(1),
    entityType: z.enum(CUSTOM_FIELD_ENTITIES),
    key: customFieldKeySchema,
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullish(),
    type: z.enum(CUSTOM_FIELD_TYPES),
    required: z.boolean().default(false),
    options: z
      .array(z.object({ label: optionLabelSchema }))
      .max(CUSTOM_FIELD_LIMITS.optionsPerField)
      .default([]),
  })
  .superRefine((value, ctx) => {
    const choice = value.type === 'select' || value.type === 'multi_select';
    if (choice && value.options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'A select field needs at least one option',
      });
    }
    if (!choice && value.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Only select fields have options',
      });
    }
    uniqueLabels(value.options, ctx);
  });
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;

/**
 * `key`, `type` and `entityType` are immutable: changing them would silently
 * reinterpret every value already stored. Options are replaced as a list, but
 * an existing option can only be renamed or archived, never removed.
 */
export const updateCustomFieldSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullish(),
    required: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    options: z
      .array(customFieldOptionInputSchema)
      .max(CUSTOM_FIELD_LIMITS.optionsPerField)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide at least one field to update',
      });
    }
    uniqueLabels(value.options, ctx);
  });
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;

export const listCustomFieldsQuerySchema = z.object({
  projectId: z.string().min(1),
  entityType: z.enum(CUSTOM_FIELD_ENTITIES).optional(),
  includeArchived: z.enum(['true', 'false']).default('false'),
});
export type ListCustomFieldsQuery = z.infer<typeof listCustomFieldsQuerySchema>;

export interface CustomFieldOptionView {
  id: string;
  label: string;
  archived: boolean;
}

export interface CustomFieldView {
  id: string;
  projectId: string;
  entityType: CustomFieldEntity;
  key: string;
  label: string;
  description: string | null;
  type: CustomFieldType;
  required: boolean;
  options: CustomFieldOptionView[];
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type CustomFieldValue = string | number | boolean | string[];
/** As stored and returned: definition id → value. */
export type CustomFieldValues = Record<string, CustomFieldValue>;

const MAX_FIELDS_PER_WRITE = CUSTOM_FIELD_LIMITS.definitionsPerEntity;

/**
 * As written: definition id → value, `null` clears. The shape is checked here;
 * whether each value fits its definition is decided by `checkCustomFieldValue`
 * on the server, which knows the definitions.
 */
export const customFieldValuesInputSchema = z
  .record(
    z.string().min(1).max(40),
    z.union([
      z.string().max(CUSTOM_FIELD_LIMITS.textLength),
      z.number(),
      z.boolean(),
      z.array(z.string().min(1).max(40)).max(CUSTOM_FIELD_LIMITS.multiSelectValues),
      z.null(),
    ]),
  )
  .refine((value) => Object.keys(value).length <= MAX_FIELDS_PER_WRITE, {
    message: `At most ${MAX_FIELDS_PER_WRITE} custom fields per write`,
  });
export type CustomFieldValuesInput = z.infer<typeof customFieldValuesInputSchema>;

export interface CustomFieldDefinitionShape {
  type: CustomFieldType;
  options: readonly CustomFieldOptionView[];
}

export type CustomFieldCheck =
  { ok: true; value: CustomFieldValue | null } | { ok: false; message: string };

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Normalises one value against its definition. `previous` is the stored value:
 * an option archived after it was chosen stays valid on that entity, but can
 * not be chosen anew. Empty text and an empty multi-select clear the value.
 */
export function checkCustomFieldValue(
  definition: CustomFieldDefinitionShape,
  value: unknown,
  previous?: CustomFieldValue,
): CustomFieldCheck {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  const chosenBefore = new Set(
    previous === undefined ? [] : Array.isArray(previous) ? previous : [String(previous)],
  );
  const selectable = (optionId: string): boolean =>
    definition.options.some(
      (option) => option.id === optionId && (!option.archived || chosenBefore.has(optionId)),
    );

  switch (definition.type) {
    case 'text': {
      if (typeof value !== 'string') return { ok: false, message: 'Expected text' };
      const trimmed = value.trim();
      if (trimmed.length > CUSTOM_FIELD_LIMITS.textLength) {
        return { ok: false, message: `At most ${CUSTOM_FIELD_LIMITS.textLength} characters` };
      }
      return { ok: true, value: trimmed.length === 0 ? null : trimmed };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, message: 'Expected a number' };
      }
      if (Math.abs(value) > CUSTOM_FIELD_LIMITS.numberMagnitude) {
        return { ok: false, message: 'Number out of range' };
      }
      return { ok: true, value };
    }
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, message: 'Expected true or false' };
    case 'date':
      return typeof value === 'string' && isRealDate(value)
        ? { ok: true, value }
        : { ok: false, message: 'Expected a date as YYYY-MM-DD' };
    case 'select':
      if (typeof value !== 'string') return { ok: false, message: 'Expected one option' };
      return selectable(value) ? { ok: true, value } : { ok: false, message: 'Unknown option' };
    case 'multi_select': {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return { ok: false, message: 'Expected a list of options' };
      }
      const unique = [...new Set(value)];
      if (unique.length > CUSTOM_FIELD_LIMITS.multiSelectValues) {
        return { ok: false, message: 'Too many options' };
      }
      if (!unique.every(selectable)) {
        return { ok: false, message: 'Unknown option' };
      }
      return { ok: true, value: unique.length === 0 ? null : unique };
    }
  }
}

/**
 * Parses a filter value from a query string for a definition, or `null` when
 * it cannot match anything of that type.
 */
export function parseCustomFieldFilter(
  type: CustomFieldType,
  raw: string,
): CustomFieldValue | null {
  switch (type) {
    case 'number': {
      const parsed = Number(raw);
      return raw.trim() === '' || !Number.isFinite(parsed) ? null : parsed;
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : null;
    default:
      return raw;
  }
}

/** Shared by the three list endpoints that accept a custom field filter. */
export const customFieldFilterQuerySchema = z.object({
  customField: z.string().min(1).max(40).optional(),
  customFieldValue: z.string().max(CUSTOM_FIELD_LIMITS.textLength).optional(),
});
