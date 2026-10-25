import { Injectable } from '@nestjs/common';
import { AuditAction, Defect } from '@prisma/client';
import {
  ChangeDefectStatusInput,
  CreateDefectInput,
  DefectView,
  ListDefectsQuery,
  Paginated,
  UpdateDefectInput,
  buildPaginationMeta,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { TenantContextService } from '../../database/tenant-context.service';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { DomainEventsPublisher } from '../../events/domain-events';
import { AuditService } from '../audit/audit.service';
import {
  CustomFieldValuesService,
  customFieldWhere,
  storedValues,
} from '../customization/custom-field-values.service';
import { DefectWorkflowService } from '../customization/defect-workflow.service';
import { OrganizationMembersRepository } from '../organizations/organization-members.repository';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { TraceabilityLinksRepository } from '../traceability/traceability-links.repository';
import { DefectsRepository } from './defects.repository';

/**
 * A defect moves through triage, work and verification. `reopened` exists so
 * that "this came back" is distinguishable from "this was never fixed". Which
 * moves are allowed is the project's workflow (S3-F7), the built-in graph
 * unless somebody configured one.
 */
@Injectable()
export class DefectsService {
  constructor(
    private readonly defects: DefectsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly members: OrganizationMembersRepository,
    private readonly links: TraceabilityLinksRepository,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsPublisher,
    private readonly customValues: CustomFieldValuesService,
    private readonly workflow: DefectWorkflowService,
  ) {}

  async create(input: CreateDefectInput, userId: string): Promise<DefectView> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);

    await this.assertAssignee(project.id, input.assigneeId);

    // The origin is derived, never trusted: given a result, the case and run it
    // belongs to are facts, and letting the client send its own would allow a
    // defect that claims to come from an execution that never happened.
    let origin: { testResultId: string; testRunId: string; testCaseId: string } | null = null;
    if (input.testResultId !== undefined && input.testResultId !== null) {
      const result = await this.defects.findResultOrigin(input.testResultId);
      // A result of another project is reported exactly like a missing one: the
      // defect's project is the only scope this request was authorized for.
      if (result === null || result.projectId !== project.id) {
        throw new NotFoundError('Test result');
      }
      if (result.status !== 'failed' && result.status !== 'blocked') {
        throw new ValidationError('A defect can only be raised from a failed or blocked result');
      }
      origin = {
        testResultId: result.id,
        testRunId: result.testRunId,
        testCaseId: result.testCaseId,
      };
    }

    const requirementIds = [...new Set(input.requirementIds)];
    const found = await this.defects.liveRequirementIds(project.id, requirementIds);
    if (found.length !== requirementIds.length) {
      throw new ValidationError(
        'Some requirements do not exist, were deleted, or belong to another project',
      );
    }

    const defect = await this.prisma.runInTransaction(async (tx) => {
      const customFields = await this.customValues.resolve(
        project.id,
        'defect',
        input.customFields,
        null,
        tx,
      );
      const key = await this.projects.nextKey(project.id, 'defectCounter', 'D', tx);

      const created = await this.defects.create(
        {
          projectId: project.id,
          key,
          title: input.title,
          ...text('description', input.description),
          ...text('stepsToReproduce', input.stepsToReproduce),
          ...text('environment', input.environment),
          severity: input.severity,
          priority: input.priority,
          ...(input.assigneeId === undefined || input.assigneeId === null
            ? {}
            : { assigneeId: input.assigneeId }),
          ...(origin === null ? {} : origin),
          reportedById: userId,
          customFields: customFields,
        },
        tx,
      );

      // A defect found while executing a case verifies nothing on its own; the
      // link is what makes it show up in the requirement's row of the matrix.
      for (const requirementId of requirementIds) {
        await this.defects.createLink(
          {
            sourceType: 'defect',
            sourceId: created.id,
            targetType: 'requirement',
            targetId: requirementId,
            linkType: 'relates_to',
            createdById: userId,
          },
          tx,
        );
      }

      if (origin !== null) {
        await this.defects.createLink(
          {
            sourceType: 'defect',
            sourceId: created.id,
            targetType: 'test_result',
            targetId: origin.testResultId,
            linkType: 'caused_by',
            createdById: userId,
          },
          tx,
        );
      }

      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'Defect',
          entityId: created.id,
          summary: `Created defect ${created.key}: ${created.title}`,
        },
        tx,
      );

      return created;
    });

    if (defect.assigneeId !== null) {
      await this.publishAssigned(defect.id, defect.projectId, defect.assigneeId, userId);
    }

    return toDefectView(defect);
  }

  async list(query: ListDefectsQuery): Promise<Paginated<DefectView>> {
    const projectId = await this.authorizedProject(query.projectId);
    if (projectId === null) {
      return { data: [], meta: buildPaginationMeta(query, 0) };
    }
    const customFilter = customFieldWhere(
      await this.customValues.filter(projectId, 'defect', query),
    );
    const page = await this.defects.list(query, {
      projectId,
      ...(customFilter.customFields === undefined
        ? {}
        : { customFields: customFilter.customFields }),
      ...(customFilter.id === undefined ? {} : { none: true }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.severity === undefined ? {} : { severity: query.severity }),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      ...(query.assigneeId === undefined ? {} : { assigneeId: query.assigneeId }),
      ...(query.testRunId === undefined ? {} : { testRunId: query.testRunId }),
      ...(query.open === undefined ? {} : { open: query.open === 'true' }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });

    return { data: page.data.map(toDefectView), meta: page.meta };
  }

  async get(id: string): Promise<DefectView> {
    return toDefectView(await this.require(id));
  }

  async update(id: string, input: UpdateDefectInput): Promise<DefectView> {
    const defect = await this.require(id);
    await this.assertAssignee(defect.projectId, input.assigneeId);

    const updated = await this.prisma.runInTransaction(async (tx) => {
      const current = await this.defects.lock(id, tx);
      if (current === null) {
        throw new NotFoundError('Defect');
      }
      const before = storedValues(current.customFields);
      const customFields =
        input.customFields === undefined
          ? undefined
          : await this.customValues.resolve(
              current.projectId,
              'defect',
              input.customFields,
              before,
              tx,
            );
      const row = await this.defects.update(
        id,
        {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.stepsToReproduce === undefined
            ? {}
            : { stepsToReproduce: input.stepsToReproduce }),
          ...(input.severity === undefined ? {} : { severity: input.severity }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.environment === undefined ? {} : { environment: input.environment }),
          ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
          ...(customFields === undefined
            ? {}
            : { customFields: customFields }),
        },
        tx,
      );
      if (row === null) {
        throw new NotFoundError('Defect');
      }
      const changed =
        customFields === undefined ? {} : CustomFieldValuesService.diff(before, customFields);
      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'Defect',
          entityId: id,
          summary: `Updated defect ${defect.key}`,
          ...(Object.keys(changed).length === 0 ? {} : { changes: { customFields: changed } }),
        },
        tx,
      );
      return row;
    });

    // Only a change of hands is news; editing the title of a defect somebody
    // already owns is not.
    if (updated.assigneeId !== null && updated.assigneeId !== defect.assigneeId) {
      await this.publishAssigned(
        id,
        updated.projectId,
        updated.assigneeId,
        this.tenant.requireUserId(),
      );
    }

    return toDefectView(updated);
  }

  private publishAssigned(
    defectId: string,
    projectId: string,
    assigneeUserId: string,
    actorUserId: string,
  ): Promise<void> {
    return this.events.publish('defect.assigned', {
      organizationId: this.tenant.requireOrganizationId(),
      projectId,
      defectId,
      assigneeUserId,
      actorUserId,
      changedAt: new Date(),
    });
  }

  async changeStatus(id: string, input: ChangeDefectStatusInput): Promise<DefectView> {
    await this.require(id);

    // Read, check and write under the row lock: two concurrent moves from the
    // same status cannot both pass the check against the status they read.
    const { defect, updated } = await this.prisma.runInTransaction(async (tx) => {
      const current = await this.defects.lock(id, tx);
      if (current === null) {
        throw new NotFoundError('Defect');
      }
      if (current.status === input.status) {
        throw new ConflictError(`Defect ${current.key} is already ${input.status}`);
      }
      await this.workflow.assertTransition(
        current.projectId,
        current.status,
        input.status,
        storedValues(current.customFields),
        tx,
      );

      const row = await this.defects.update(
        id,
        {
          status: input.status,
          // Timestamps are set once and cleared on reopen, so "time to
          // resolution" measures the current life of the defect.
          ...(input.status === 'resolved' ? { resolvedAt: new Date() } : {}),
          ...(input.status === 'closed' || input.status === 'rejected'
            ? { closedAt: new Date() }
            : {}),
          ...(input.status === 'reopened' ? { resolvedAt: null, closedAt: null } : {}),
        },
        tx,
      );
      if (row === null) {
        throw new NotFoundError('Defect');
      }

      await this.audit.record(
        {
          action: AuditAction.update,
          entityType: 'Defect',
          entityId: id,
          summary: `Moved defect ${current.key} from ${current.status} to ${input.status}`,
          changes: {
            status: { from: current.status, to: input.status },
            ...(input.comment === undefined || input.comment === null
              ? {}
              : { comment: input.comment }),
          },
        },
        tx,
      );
      return { defect: current, updated: row };
    });

    await this.events.publish('defect.status.changed', {
      organizationId: updated.organizationId,
      projectId: updated.projectId,
      defectId: id,
      fromStatus: defect.status,
      toStatus: updated.status,
      actorUserId: this.tenant.requireUserId(),
      changedAt: new Date(),
    });

    return toDefectView(updated);
  }

  async remove(id: string): Promise<void> {
    const defect = await this.require(id);

    await this.prisma.runInTransaction(async (tx) => {
      if (!(await this.defects.softDelete(id, tx))) {
        throw new NotFoundError('Defect');
      }

      // Including the link back to the result the defect came from. The result
      // is untouched: the evidence that a test failed is not the same fact as
      // the claim that a defect explains it.
      const purged = await this.links.purgeFor('defect', [id], tx);

      await this.audit.record(
        {
          action: AuditAction.delete,
          entityType: 'Defect',
          entityId: id,
          summary: `Deleted defect ${defect.key}`,
          ...(purged === 0 ? {} : { changes: { removedTraceabilityLinks: purged } }),
        },
        tx,
      );
    });
  }

  private async assertAssignee(
    projectId: string,
    assigneeId: string | null | undefined,
  ): Promise<void> {
    if (assigneeId === undefined || assigneeId === null) {
      return;
    }
    const membership = await this.members.findActiveMembership(
      assigneeId,
      this.tenant.requireOrganizationId(),
    );
    if (membership === null) {
      throw new ValidationError('The assignee is not a member of this organization');
    }
    if (!(await this.access.memberSees(projectId, assigneeId, membership.role))) {
      throw new ValidationError('The assignee has no access to this project');
    }
  }

  /** `null` for a project that does not exist or is not visible: the list is empty. */
  private authorizedProject(projectId: string): Promise<string | null> {
    return this.access.authorizeProjectScope(projectId);
  }

  private async require(id: string): Promise<Defect> {
    const defect = await this.defects.findById(id);
    if (defect === null) {
      throw new NotFoundError('Defect');
    }
    await this.access.assertRouteAccess(defect.projectId, 'Defect');
    return defect;
  }
}

function text<K extends string>(
  key: K,
  value: string | null | undefined,
): Record<K, string> | Record<string, never> {
  return value === undefined || value === null ? {} : ({ [key]: value } as Record<K, string>);
}

export function toDefectView(defect: Defect): DefectView {
  return {
    id: defect.id,
    projectId: defect.projectId,
    key: defect.key,
    title: defect.title,
    description: defect.description,
    stepsToReproduce: defect.stepsToReproduce,
    severity: defect.severity,
    priority: defect.priority,
    status: defect.status,
    environment: defect.environment,
    testResultId: defect.testResultId,
    testCaseId: defect.testCaseId,
    testRunId: defect.testRunId,
    reportedById: defect.reportedById,
    assigneeId: defect.assigneeId,
    resolvedAt: defect.resolvedAt?.toISOString() ?? null,
    closedAt: defect.closedAt?.toISOString() ?? null,
    customFields: storedValues(defect.customFields),
    createdAt: defect.createdAt.toISOString(),
    updatedAt: defect.updatedAt.toISOString(),
  };
}
