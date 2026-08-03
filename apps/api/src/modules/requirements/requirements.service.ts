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
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { ConflictError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectsRepository } from '../projects/projects.repository';
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
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateRequirementInput, userId: string): Promise<RequirementView> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }

    // Reserving the key increments a counter on the project, so it must roll
    // back with the requirement it was reserved for. Otherwise a failed create
    // leaves a permanent hole in the numbering.
    const requirement = await this.prisma.runInTransaction(async (tx) => {
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
    const page = await this.requirements.list(query, {
      projectId: query.projectId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      ...(query.tag === undefined ? {} : { tag: query.tag }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });

    return { data: page.data.map(toRequirementView), meta: page.meta };
  }

  async get(id: string): Promise<RequirementView> {
    return toRequirementView(await this.require(id));
  }

  async update(
    id: string,
    input: UpdateRequirementInput,
    userId: string,
  ): Promise<RequirementView> {
    const existing = await this.require(id);

    const updated = await this.prisma.runInTransaction(async (tx) => {
      const row = await this.requirements.update(
        id,
        {
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
          changes: changedFields(existing, row),
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
    if (!(await this.requirements.softDelete(id))) {
      throw new NotFoundError('Requirement');
    }

    await this.audit.record({
      action: AuditAction.delete,
      entityType: 'Requirement',
      entityId: id,
      summary: `Deleted ${requirement.key}`,
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
    return requirement;
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
