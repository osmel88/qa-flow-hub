import { Injectable } from '@nestjs/common';
import { CustomFieldDefinition, CustomFieldEntity, Prisma } from '@prisma/client';
import {
  CustomFieldOptionView,
  CustomFieldValue,
  CustomFieldValues,
  CustomFieldValuesInput,
  checkCustomFieldValue,
  parseCustomFieldFilter,
} from '@qa-flow-hub/shared';
import { PrismaTransaction } from '../../database/prisma.service';
import { ValidationError } from '../../errors';
import { CustomFieldsRepository } from './custom-fields.repository';

export function optionsOf(definition: CustomFieldDefinition): CustomFieldOptionView[] {
  return Array.isArray(definition.options)
    ? (definition.options as unknown as CustomFieldOptionView[])
    : [];
}

export function storedValues(value: Prisma.JsonValue): CustomFieldValues {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as unknown as CustomFieldValues)
    : {};
}

/** A filter that can never match, so an unknown field yields an empty page. */
export type CustomFieldWhere =
  | { path: string[]; equals?: Prisma.InputJsonValue; array_contains?: Prisma.InputJsonValue }
  | 'none';

/**
 * Validates and merges the custom field values of one entity write, inside the
 * transaction of that write. Every error names the field, so a form can point
 * at it.
 */
@Injectable()
export class CustomFieldValuesService {
  constructor(private readonly fields: CustomFieldsRepository) {}

  async resolve(
    projectId: string,
    entityType: CustomFieldEntity,
    input: CustomFieldValuesInput | undefined,
    previous: CustomFieldValues | null,
    tx: PrismaTransaction,
  ): Promise<CustomFieldValues> {
    const definitions = await this.fields.lockForValues(projectId, entityType, tx);
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const merged: CustomFieldValues = { ...(previous ?? {}) };
    const problems: Array<{ path: string; message: string }> = [];

    for (const [id, raw] of Object.entries(input ?? {})) {
      const definition = byId.get(id);
      // Another project's, another tenant's or an invented id all read the same.
      if (definition === undefined) {
        problems.push({ path: `customFields.${id}`, message: 'Unknown custom field' });
        continue;
      }
      if (definition.archivedAt !== null) {
        problems.push({
          path: `customFields.${id}`,
          message: `${definition.label} is archived and can no longer be edited`,
        });
        continue;
      }
      const check = checkCustomFieldValue(
        { type: definition.type, options: optionsOf(definition) },
        raw,
        previous?.[id],
      );
      if (!check.ok) {
        problems.push({
          path: `customFields.${id}`,
          message: `${definition.label}: ${check.message}`,
        });
        continue;
      }
      if (check.value === null) {
        delete merged[id];
      } else {
        merged[id] = check.value;
      }
    }

    // Required is enforced on create and whenever a write would leave it
    // empty; making a field required later does not invalidate old rows until
    // somebody edits that field.
    for (const definition of definitions) {
      if (!definition.required || definition.archivedAt !== null) continue;
      const touched = input !== undefined && definition.id in input;
      if ((previous === null || touched) && merged[definition.id] === undefined) {
        problems.push({
          path: `customFields.${definition.id}`,
          message: `${definition.label} is required`,
        });
      }
    }

    if (problems.length > 0) {
      throw new ValidationError('Some custom fields are invalid', problems);
    }
    return merged;
  }

  /** Changed values only, for the audit trail. */
  static diff(
    before: CustomFieldValues,
    after: CustomFieldValues,
  ): Record<string, { from: CustomFieldValue | null; to: CustomFieldValue | null }> {
    const changes: Record<string, { from: CustomFieldValue | null; to: CustomFieldValue | null }> =
      {};
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[id] ?? null) !== JSON.stringify(after[id] ?? null)) {
        changes[id] = { from: before[id] ?? null, to: after[id] ?? null };
      }
    }
    return changes;
  }

  /** Translates `customField` + `customFieldValue` into a JSONB filter. */
  async filter(
    projectId: string,
    entityType: CustomFieldEntity,
    query: { customField?: string | undefined; customFieldValue?: string | undefined },
  ): Promise<CustomFieldWhere | undefined> {
    if (query.customField === undefined) {
      return undefined;
    }
    if (query.customFieldValue === undefined) {
      throw new ValidationError('customFieldValue is required with customField', [
        { path: 'customFieldValue', message: 'Required' },
      ]);
    }
    const definition = await this.fields.findById(query.customField);
    if (
      definition === null ||
      definition.projectId !== projectId ||
      definition.entityType !== entityType
    ) {
      return 'none';
    }
    const value = parseCustomFieldFilter(definition.type, query.customFieldValue);
    if (value === null) {
      return 'none';
    }
    return definition.type === 'multi_select'
      ? { path: [definition.id], array_contains: [value] }
      : { path: [definition.id], equals: value as Prisma.InputJsonValue };
  }
}

/** Builds the `where` fragment for a repository from a resolved filter. */
export function customFieldWhere(filter: CustomFieldWhere | undefined): {
  customFields?: Prisma.JsonFilter;
  id?: { in: string[] };
} {
  if (filter === undefined) return {};
  if (filter === 'none') return { id: { in: [] } };
  return { customFields: filter };
}
