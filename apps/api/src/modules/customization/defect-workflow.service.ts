import { Injectable } from '@nestjs/common';
import { AuditAction, DefectStatus, DefectWorkflow, Prisma } from '@prisma/client';
import {
  CustomFieldValues,
  DEFAULT_DEFECT_TRANSITIONS,
  DefectWorkflowView,
  UpdateDefectWorkflowInput,
  WorkflowTransition,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantContextService } from '../../database/tenant-context.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { CustomFieldsRepository } from './custom-fields.repository';

function transitionsOf(workflow: DefectWorkflow | null): WorkflowTransition[] {
  return workflow === null
    ? DEFAULT_DEFECT_TRANSITIONS.map((transition) => ({ ...transition, requiredFieldIds: [] }))
    : (workflow.transitions as unknown as WorkflowTransition[]);
}

@Injectable()
export class DefectWorkflowService {
  constructor(
    private readonly fields: CustomFieldsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(projectId: string): Promise<DefectWorkflowView> {
    const project = await this.projects.findById(projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    return toWorkflowView(project.id, await this.fields.findWorkflow(project.id));
  }

  async update(input: UpdateDefectWorkflowInput): Promise<DefectWorkflowView> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    const userId = this.tenant.requireUserId();

    const definitions = await this.fields.list(project.id, 'defect', false);
    const usable = new Set(definitions.map((definition) => definition.id));
    const problems = input.transitions.flatMap((transition, index) =>
      transition.requiredFieldIds
        .filter((id) => !usable.has(id))
        .map((id) => ({
          path: `transitions.${index}.requiredFieldIds`,
          message: `${id} is not an active defect custom field of this project`,
        })),
    );
    if (problems.length > 0) {
      throw new ValidationError('The workflow references unknown custom fields', problems);
    }
    const transitions = input.transitions.map((transition) => ({
      ...transition,
      requiredFieldIds: [...new Set(transition.requiredFieldIds)],
    })) as unknown as Prisma.InputJsonValue;

    try {
      const saved = await this.prisma.runInTransaction(async (tx) => {
        const current = await this.fields.lockWorkflow(project.id, 'update', tx);
        const currentVersion = current?.version ?? 0;
        if (currentVersion !== input.version) {
          throw new ConflictError('The workflow changed since it was loaded; reload and retry', {
            currentVersion,
          });
        }
        const row =
          current === null
            ? await this.fields.createWorkflow(project.id, transitions, userId, tx)
            : await this.fields.updateWorkflow(project.id, input.version, transitions, userId, tx);
        if (row === null) {
          throw new ConflictError('The workflow changed since it was loaded; reload and retry');
        }
        await this.audit.record(
          {
            action: AuditAction.update,
            entityType: 'DefectWorkflow',
            entityId: row.id,
            summary: `Configured the defect workflow (version ${row.version})`,
            changes: { transitions: input.transitions.length, version: row.version },
          },
          tx,
        );
        return row;
      });
      return toWorkflowView(project.id, saved);
    } catch (error) {
      // Two first-time saves racing: the unique projectId lets one through.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('The workflow changed since it was loaded; reload and retry');
      }
      throw error;
    }
  }

  /**
   * Checks one move inside the caller's transaction. The workflow row is held
   * `FOR SHARE`, so a reconfiguration either happens before the move is
   * checked or waits for it to commit.
   */
  async assertTransition(
    projectId: string,
    from: DefectStatus,
    to: DefectStatus,
    values: CustomFieldValues,
    tx: PrismaTransaction,
  ): Promise<void> {
    const workflow = await this.fields.lockWorkflow(projectId, 'share', tx);
    const transitions = transitionsOf(workflow);
    const transition = transitions.find((item) => item.from === from && item.to === to);
    if (transition === undefined) {
      throw new ConflictError(`A defect cannot move from ${from} to ${to}`, {
        allowed: transitions.filter((item) => item.from === from).map((item) => item.to),
      });
    }
    if (
      transition.permission !== 'defects.create' &&
      !(await this.access.hasPermission(projectId, transition.permission))
    ) {
      throw new ForbiddenError(
        `Moving a defect from ${from} to ${to} needs ${transition.permission}`,
      );
    }
    if (transition.requiredFieldIds.length > 0) {
      const definitions = await this.fields.lockForValues(projectId, 'defect', tx);
      const missing = definitions.filter(
        (definition) =>
          transition.requiredFieldIds.includes(definition.id) &&
          definition.archivedAt === null &&
          values[definition.id] === undefined,
      );
      if (missing.length > 0) {
        throw new ValidationError(
          `Fill ${missing.map((definition) => definition.label).join(', ')} before moving to ${to}`,
          missing.map((definition) => ({
            path: `customFields.${definition.id}`,
            message: `${definition.label} is required to move to ${to}`,
          })),
        );
      }
    }
  }
}

function toWorkflowView(projectId: string, workflow: DefectWorkflow | null): DefectWorkflowView {
  return {
    projectId,
    version: workflow?.version ?? 0,
    customized: workflow !== null,
    transitions: transitionsOf(workflow),
    updatedAt: workflow?.updatedAt.toISOString() ?? null,
  };
}
