import { Injectable } from '@nestjs/common';
import {
  AuditAction,
  Prisma,
  Requirement,
  RequirementStatus,
  RequirementVersion,
} from '@prisma/client';
import {
  ChangeRequirementStatusInput,
  CreateRequirementInput,
  ListRequirementsQuery,
  Paginated,
  RequirementView,
  RequirementVersionView,
  UpdateRequirementInput,
  buildPaginationMeta,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { ConflictError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import {
  CustomFieldValuesService,
  customFieldWhere,
  storedValues,
} from '../customization/custom-field-values.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { TraceabilityLinksRepository } from '../traceability/traceability-links.repository';
import { RequirementLinksService } from '../requirement-links/requirement-links.service';
import { RequirementsRepository } from './requirements.repository';

/**
 * Which status transitions are legal. A requirement that jumps from `draft` to
 * `implemented` skipped review, and a workflow that allows every transition is
 * not a workflow — it is a dropdown.
 *
 * `obsolete` is reachable from anywhere: deciding something is no longer needed
 * can happen at any point, and it is the reversible alternative to deletion.
 */
const ALLOWED_TRANSITIONS: Record<RequirementStatus, RequirementStatus[]> = {
  draft: ['in_review', 'obsolete'],
  in_review: ['draft', 'approved', 'obsolete'],
  approved: ['in_review', 'implemented', 'obsolete'],
  implemented: ['approved', 'obsolete'],
  obsolete: ['draft'],
};

@Injectable()
export class RequirementsService {
  constructor(
    private readonly requirements: RequirementsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly links: TraceabilityLinksRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customValues: CustomFieldValuesService,
    private readonly implementations: RequirementLinksService,
  ) {}

  async create(input: CreateRequirementInput, userId: string): Promise<RequirementView> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);

    // Reserving the key increments a counter on the project, so it must roll
    // back with the requirement it was reserved for. Otherwise a failed create
    // leaves a permanent hole in the numbering.
    const requirement = await this.prisma.runInTransaction(async (tx) => {
      const customFields = await this.customValues.resolve(
        project.id,
        'requirement',
        input.customFields,
        null,
        tx,
      );
      const key = await this.projects.nextKey(project.id, 'requirementCounter', 'R', tx);

      const created = await this.requirements.create(
        {
          projectId: project.id,
          key,
          title: input.title,
          ...(input.description === undefined || input.description === null
            ? {}
            : { description: input.description }),
          ...(input.acceptanceCriteria === undefined || input.acceptanceCriteria === null
            ? {}
            : { acceptanceCriteria: input.acceptanceCriteria }),
          type: input.type,
          priority: input.priority,
          tags: input.tags,
          customFields: customFields,
          createdById: userId,
        },
        tx,
      );

      await this.requirements.appendVersion(created.id, snapshotOf(created), userId, tx);
      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'Requirement',
          entityId: created.id,
          summary: `Created ${created.key} — ${created.title}`,
        },
        tx,
      );

      return created;
    });

    return toRequirementView(requirement);
  }

  async list(query: ListRequirementsQuery): Promise<Paginated<RequirementView>> {
    const projectId = await this.authorizedProject(query.projectId);
    if (projectId === null) {
      return { data: [], meta: buildPaginationMeta(query, 0) };
    }
    const customFilter = customFieldWhere(
      await this.customValues.filter(projectId, 'requirement', query),
    );
    const page = await this.requirements.list(query, {
      projectId,
      ...customFilter,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      ...(query.tag === undefined ? {} : { tag: query.tag }),
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.implementation === undefined
        ? {}
        : {
            implementation: await this.implementations.filterFor(projectId, query.implementation),
          }),
    });

    const implementation = await this.implementations.implementationOf(page.data);
    return {
      data: page.data.map((row) => ({
        ...toRequirementView(row),
        ...withImplementation(implementation.get(row.id)),
      })),
      meta: page.meta,
    };
  }

  async get(id: string): Promise<RequirementView> {
    const requirement = await this.require(id);
    const implementation = await this.implementations.implementationOf([requirement]);
    return {
      ...toRequirementView(requirement),
      ...withImplementation(implementation.get(requirement.id)),
    };
  }

  async update(
    id: string,
    input: UpdateRequirementInput,
    userId: string,
  ): Promise<RequirementView> {
    const existing = await this.require(id);

    const updated = await this.prisma.runInTransaction(async (tx) => {
      const before = await this.requirements.lockCustomFields(id, tx);
      const customFields =
        input.customFields === undefined
          ? undefined
          : await this.customValues.resolve(
              existing.projectId,
              'requirement',
              input.customFields,
              before,
              tx,
            );
      const customChanges =
        customFields === undefined ? {} : CustomFieldValuesService.diff(before, customFields);
      const row = await this.requirements.update(
        id,
        {
          ...(customFields === undefined ? {} : { customFields: customFields }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.acceptanceCriteria === undefined
            ? {}
            : { acceptanceCriteria: input.acceptanceCriteria }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
        },
        tx,
      );
      if (row === null) {
        throw new NotFoundError('Requirement');
      }

      // The snapshot is taken *after* the write: a version row describes what
      // the requirement said, not what it stopped saying. Reading history then
      // means reading forward, and the previous state is the previous row.
      await this.requirements.appendVersion(id, snapshotOf(row), userId, tx);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'Requirement',
          entityId: id,
          summary: `Updated ${row.key}`,
          changes: {
            ...(changedFields(existing, row) as Record<string, Prisma.InputJsonValue>),
            ...(Object.keys(customChanges).length === 0
              ? {}
              : { customFields: customChanges as unknown as Prisma.InputJsonValue }),
          },
        },
        tx,
      );

      return row;
    });

    return toRequirementView(updated);
  }

  async changeStatus(
    id: string,
    input: ChangeRequirementStatusInput,
    userId: string,
  ): Promise<RequirementView> {
    const existing = await this.require(id);

    if (existing.status === input.status) {
      return toRequirementView(existing);
    }
    if (!ALLOWED_TRANSITIONS[existing.status].includes(input.status)) {
      throw new ConflictError(
        `A requirement cannot move from ${existing.status} to ${input.status}`,
        { allowed: ALLOWED_TRANSITIONS[existing.status] },
      );
    }

    const updated = await this.prisma.runInTransaction(async (tx) => {
      const row = await this.requirements.update(id, { status: input.status }, tx);
      if (row === null) {
        throw new NotFoundError('Requirement');
      }

      await this.requirements.appendVersion(id, snapshotOf(row), userId, tx);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'Requirement',
          entityId: id,
          summary: `Moved ${row.key} from ${existing.status} to ${input.status}`,
          changes: { status: { from: existing.status, to: input.status } },
        },
        tx,
      );

      return row;
    });

    return toRequirementView(updated);
  }

  async remove(id: string): Promise<void> {
    const requirement = await this.require(id);

    await this.prisma.runInTransaction(async (tx) => {
      if (!(await this.requirements.softDelete(id, tx))) {
        throw new NotFoundError('Requirement');
      }

      // A link to a deleted requirement is not history, it is a claim about
      // coverage that nothing backs. It goes in the same transaction, so the
      // matrix can never observe a requirement that is gone but still linked.
      const purged = await this.links.purgeFor('requirement', [id], tx);

      await this.audit.record(
        {
          action: AuditAction.delete,
          entityType: 'Requirement',
          entityId: id,
          summary: `Deleted ${requirement.key}`,
          ...(purged === 0 ? {} : { changes: { removedTraceabilityLinks: purged } }),
        },
        tx,
      );
    });
  }

  async history(id: string): Promise<RequirementVersionView[]> {
    await this.require(id);
    return (await this.requirements.listVersions(id)).map(toVersionView);
  }

  private async require(id: string): Promise<Requirement> {
    const requirement = await this.requirements.findById(id);
    if (requirement === null) {
      throw new NotFoundError('Requirement');
    }
    // The requirement carries the project, so this is the first point at which
    // the project-scoped role can be checked.
    await this.access.assertRouteAccess(requirement.projectId, 'Requirement');
    return requirement;
  }

  /** `null` for a project that does not exist or is not visible: the list is empty. */
  private authorizedProject(projectId: string): Promise<string | null> {
    return this.access.authorizeProjectScope(projectId);
  }
}

function snapshotOf(requirement: Requirement): Prisma.InputJsonValue {
  return {
    title: requirement.title,
    description: requirement.description,
    acceptanceCriteria: requirement.acceptanceCriteria,
    type: requirement.type,
    priority: requirement.priority,
    status: requirement.status,
    tags: requirement.tags,
  };
}

/** Only the fields that actually moved, so the audit entry stays readable. */
function changedFields(before: Requirement, after: Requirement): Prisma.InputJsonValue {
  const fields = ['title', 'type', 'priority', 'status'] as const;
  const changes: Record<string, { from: string; to: string }> = {};

  for (const field of fields) {
    if (before[field] !== after[field]) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  if (before.description !== after.description) {
    changes['description'] = { from: '(changed)', to: '(changed)' };
  }
  return changes;
}

export function toRequirementView(requirement: Requirement): RequirementView {
  return {
    id: requirement.id,
    projectId: requirement.projectId,
    key: requirement.key,
    title: requirement.title,
    description: requirement.description,
    acceptanceCriteria: requirement.acceptanceCriteria,
    type: requirement.type,
    priority: requirement.priority,
    status: requirement.status,
    tags: requirement.tags,
    customFields: storedValues(requirement.customFields),
    createdById: requirement.createdById,
    createdAt: requirement.createdAt.toISOString(),
    updatedAt: requirement.updatedAt.toISOString(),
  };
}

function toVersionView(version: RequirementVersion): RequirementVersionView {
  return {
    version: version.version,
    changedById: version.changedById,
    changedAt: version.changedAt.toISOString(),
    snapshot: version.snapshot as Record<string, unknown>,
  };
}

function withImplementation(
  entry: { implementation: NonNullable<RequirementView['implementation']> } | undefined,
): Pick<RequirementView, 'implementation'> {
  return entry === undefined ? {} : { implementation: entry.implementation };
}
