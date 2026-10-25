import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditAction, CustomFieldDefinition, Prisma } from '@prisma/client';
import {
  CUSTOM_FIELD_LIMITS,
  CreateCustomFieldInput,
  CustomFieldOptionView,
  CustomFieldView,
  ListCustomFieldsQuery,
  UpdateCustomFieldInput,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import {
  ConflictError,
  DuplicateResourceError,
  NotFoundError,
  ValidationError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { optionsOf } from './custom-field-values.service';
import { CustomFieldsRepository } from './custom-fields.repository';

function optionId(): string {
  return `opt_${randomBytes(6).toString('base64url')}`;
}

@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly fields: CustomFieldsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateCustomFieldInput, userId: string): Promise<CustomFieldView> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);

    try {
      const created = await this.prisma.runInTransaction(async (tx) => {
        // The per-project lock makes the count and the insert one step, so
        // concurrent creates cannot overshoot the limit.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`custom-fields:${project.id}`}, 0))`;
        const active = await this.fields.countActive(project.id, input.entityType, tx);
        if (active >= CUSTOM_FIELD_LIMITS.definitionsPerEntity) {
          throw new ConflictError(
            `A project can have at most ${CUSTOM_FIELD_LIMITS.definitionsPerEntity} active custom fields per entity`,
          );
        }
        const definition = await this.fields.create(
          {
            projectId: project.id,
            entityType: input.entityType,
            key: input.key,
            label: input.label,
            ...(input.description === undefined || input.description === null
              ? {}
              : { description: input.description }),
            type: input.type,
            required: input.required,
            options: input.options.map((option) => ({
              id: optionId(),
              label: option.label,
              archived: false,
            })),
            position: active,
            createdById: userId,
          },
          tx,
        );
        await this.audit.record(
          {
            action: AuditAction.create,
            entityType: 'CustomFieldDefinition',
            entityId: definition.id,
            summary: `Created ${input.entityType} custom field ${input.key}`,
            changes: { type: input.type, required: input.required },
          },
          tx,
        );
        return definition;
      });
      return toCustomFieldView(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateResourceError('custom field', 'key');
      }
      throw error;
    }
  }

  async list(query: ListCustomFieldsQuery): Promise<CustomFieldView[]> {
    const projectId = await this.access.authorizeProjectScope(query.projectId);
    if (projectId === null) {
      return [];
    }
    const rows = await this.fields.list(
      projectId,
      query.entityType,
      query.includeArchived === 'true',
    );
    return rows.map(toCustomFieldView);
  }

  async get(id: string): Promise<CustomFieldView> {
    return toCustomFieldView(await this.require(id));
  }

  async update(id: string, input: UpdateCustomFieldInput): Promise<CustomFieldView> {
    await this.require(id);
    const updated = await this.prisma.runInTransaction(async (tx) => {
      const current = await this.fields.lockForUpdate(id, tx);
      if (current === null) {
        throw new NotFoundError('Custom field');
      }
      if (current.archivedAt !== null) {
        throw new ConflictError('An archived custom field cannot be edited; restore it first');
      }
      const options =
        input.options === undefined ? undefined : mergeOptions(current, input.options);
      const row = await this.fields.update(
        id,
        {
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.required === undefined ? {} : { required: input.required }),
          ...(input.position === undefined ? {} : { position: input.position }),
          ...(options === undefined
            ? {}
            : { options: options as unknown as Prisma.InputJsonValue }),
        },
        tx,
      );
      if (row === null) {
        throw new NotFoundError('Custom field');
      }
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'CustomFieldDefinition',
          entityId: id,
          summary: `Updated custom field ${current.key}`,
          changes: {
            ...(input.label === undefined ? {} : { label: { from: current.label, to: row.label } }),
            ...(input.required === undefined
              ? {}
              : { required: { from: current.required, to: row.required } }),
            ...(options === undefined ? {} : { options: options.length }),
          },
        },
        tx,
      );
      return row;
    });
    return toCustomFieldView(updated);
  }

  /** Values stay on every entity; the field just stops being offered. */
  async setArchived(id: string, archived: boolean): Promise<CustomFieldView> {
    await this.require(id);
    const updated = await this.prisma.runInTransaction(async (tx) => {
      const current = await this.fields.lockForUpdate(id, tx);
      if (current === null) {
        throw new NotFoundError('Custom field');
      }
      if ((current.archivedAt !== null) === archived) {
        throw new ConflictError(
          `Custom field ${current.key} is already ${archived ? 'archived' : 'active'}`,
        );
      }
      if (!archived) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`custom-fields:${current.projectId}`}, 0))`;
        const active = await this.fields.countActive(current.projectId, current.entityType, tx);
        if (active >= CUSTOM_FIELD_LIMITS.definitionsPerEntity) {
          throw new ConflictError('The project already has the maximum of active custom fields');
        }
      }
      const row = await this.fields.update(id, { archivedAt: archived ? new Date() : null }, tx);
      if (row === null) {
        throw new NotFoundError('Custom field');
      }
      await this.audit.record(
        {
          action: archived ? AuditAction.archive : AuditAction.restore,
          entityType: 'CustomFieldDefinition',
          entityId: id,
          summary: `${archived ? 'Archived' : 'Restored'} custom field ${current.key}`,
        },
        tx,
      );
      return row;
    });
    return toCustomFieldView(updated);
  }

  private async require(id: string): Promise<CustomFieldDefinition> {
    const definition = await this.fields.findById(id);
    if (definition === null) {
      throw new NotFoundError('Custom field');
    }
    await this.access.assertRouteAccess(definition.projectId, 'Custom field');
    return definition;
  }
}

/**
 * Existing options can be renamed or archived but never dropped: a value that
 * points at an option must keep resolving to a label.
 */
function mergeOptions(
  definition: CustomFieldDefinition,
  input: NonNullable<UpdateCustomFieldInput['options']>,
): CustomFieldOptionView[] {
  if (definition.type !== 'select' && definition.type !== 'multi_select') {
    throw new ValidationError('Only select fields have options', [
      { path: 'options', message: 'Only select fields have options' },
    ]);
  }
  const existing = optionsOf(definition);
  const byId = new Map(existing.map((option) => [option.id, option]));
  const next: CustomFieldOptionView[] = [];
  for (const [index, option] of input.entries()) {
    if (option.id !== undefined && !byId.has(option.id)) {
      throw new ValidationError('Unknown option', [
        { path: `options.${index}.id`, message: 'Unknown option' },
      ]);
    }
    next.push({ id: option.id ?? optionId(), label: option.label, archived: option.archived });
  }
  const kept = new Set(next.map((option) => option.id));
  const dropped = existing.filter((option) => !kept.has(option.id));
  if (dropped.length > 0) {
    throw new ValidationError('Options cannot be removed, only archived', [
      { path: 'options', message: `Missing ${dropped.map((option) => option.label).join(', ')}` },
    ]);
  }
  if (!next.some((option) => !option.archived)) {
    throw new ValidationError('A select field needs at least one active option', [
      { path: 'options', message: 'At least one option must stay active' },
    ]);
  }
  return next;
}

export function toCustomFieldView(definition: CustomFieldDefinition): CustomFieldView {
  return {
    id: definition.id,
    projectId: definition.projectId,
    entityType: definition.entityType,
    key: definition.key,
    label: definition.label,
    description: definition.description,
    type: definition.type,
    required: definition.required,
    options: optionsOf(definition),
    position: definition.position,
    archivedAt: definition.archivedAt?.toISOString() ?? null,
    createdAt: definition.createdAt.toISOString(),
    updatedAt: definition.updatedAt.toISOString(),
  };
}
