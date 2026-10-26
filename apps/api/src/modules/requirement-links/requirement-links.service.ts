import { Injectable } from '@nestjs/common';
import { AuditAction, Requirement } from '@prisma/client';
import {
  ImplementationState,
  LinkedRequirementView,
  LinkedWorkItemView,
  RequirementImplementation,
  RequirementLinkResult,
  RequirementLinkType,
  RequirementWorkItemsView,
  computeImplementation,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import {
  LinkWithRequirement,
  LinkWithWorkItem,
  RequirementLinksRepository,
} from './requirement-links.repository';

interface LinkEnds {
  requirementId: string;
  workItemId: string;
  linkType: RequirementLinkType;
}

/**
 * Work items implement requirements (S4-F4). Both ends must be live, in the
 * same project, and visible to the caller; any other id answers like a
 * missing one. Linking and unlinking are idempotent.
 */
@Injectable()
export class RequirementLinksService {
  constructor(
    private readonly links: RequirementLinksRepository,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async link(ends: LinkEnds, userId: string): Promise<RequirementLinkResult> {
    return this.prisma.runInTransaction(async (tx) => {
      // Always requirement first, then work item: one lock order, no deadlock.
      const requirement = await this.links.lockRequirement(ends.requirementId, tx);
      if (requirement === null) {
        throw new NotFoundError('Requirement');
      }
      await this.authorize(requirement.projectId);
      const workItem = await this.links.lockWorkItem(ends.workItemId, tx);
      if (workItem === null || workItem.projectId !== requirement.projectId) {
        throw new NotFoundError('Work item');
      }
      const created = await this.links.insert(
        {
          projectId: requirement.projectId,
          requirementId: requirement.id,
          workItemId: workItem.id,
          linkType: ends.linkType,
          createdById: userId,
        },
        tx,
      );
      if (created) {
        const row = await this.links.find(requirement.id, workItem.id, ends.linkType, tx);
        await this.audit.record(
          {
            action: AuditAction.create,
            entityType: 'RequirementWorkItemLink',
            entityId: row?.id ?? `${requirement.id}:${workItem.id}`,
            summary: `Linked ${workItem.key} ${ends.linkType} ${requirement.key}`,
            changes: { requirementId: requirement.id, workItemId: workItem.id },
          },
          tx,
        );
      }
      return {
        created,
        requirementId: requirement.id,
        workItemId: workItem.id,
        linkType: ends.linkType,
      };
    });
  }

  /** Removing a link that is not there succeeds and records nothing. */
  async unlink(ends: LinkEnds): Promise<void> {
    await this.prisma.runInTransaction(async (tx) => {
      const requirement = await this.links.lockRequirement(ends.requirementId, tx);
      if (requirement === null) {
        throw new NotFoundError('Requirement');
      }
      await this.authorize(requirement.projectId);
      const workItem = await this.links.lockWorkItem(ends.workItemId, tx);
      if (workItem === null || workItem.projectId !== requirement.projectId) {
        throw new NotFoundError('Work item');
      }
      const removed = await this.links.remove(requirement.id, workItem.id, ends.linkType, tx);
      if (removed !== null) {
        await this.audit.record(
          {
            action: AuditAction.delete,
            entityType: 'RequirementWorkItemLink',
            entityId: removed,
            summary: `Unlinked ${workItem.key} from ${requirement.key}`,
            changes: { requirementId: requirement.id, workItemId: workItem.id },
          },
          tx,
        );
      }
    });
  }

  async forRequirement(requirementId: string): Promise<RequirementWorkItemsView> {
    const requirement = await this.prisma.runInTransaction((tx) =>
      this.links.lockRequirement(requirementId, tx),
    );
    if (requirement === null) {
      throw new NotFoundError('Requirement');
    }
    await this.access.assertRouteAccess(requirement.projectId, 'Requirement');
    await this.access.assertPermission(requirement.projectId, 'work_items.read');
    const rows = await this.links.forRequirements([requirement.id]);
    const workItems = rows.map(toLinkedWorkItem);
    return {
      requirementId: requirement.id,
      implementation: computeImplementation(workItems.map((item) => item.status)),
      workItems,
    };
  }

  /** For the work item detail; the caller has already authorized the item. */
  async requirementsOf(workItemId: string): Promise<LinkedRequirementView[]> {
    return (await this.links.forWorkItem(workItemId)).map(toLinkedRequirement);
  }

  async forWorkItem(workItemId: string): Promise<LinkedRequirementView[]> {
    const workItem = await this.prisma.runInTransaction((tx) =>
      this.links.lockWorkItem(workItemId, tx),
    );
    if (workItem === null) {
      throw new NotFoundError('Work item');
    }
    await this.access.assertRouteAccess(workItem.projectId, 'Work item');
    await this.access.assertPermission(workItem.projectId, 'requirements.read');
    return this.requirementsOf(workItem.id);
  }

  /** Implementation of each requirement (already authorized by the caller). */
  async implementationOf(
    requirements: readonly Pick<Requirement, 'id'>[],
  ): Promise<
    Map<string, { implementation: RequirementImplementation; workItems: LinkedWorkItemView[] }>
  > {
    const rows = await this.links.forRequirements(requirements.map((row) => row.id));
    const grouped = new Map<string, LinkedWorkItemView[]>();
    for (const row of rows) {
      const list = grouped.get(row.requirementId) ?? [];
      list.push(toLinkedWorkItem(row));
      grouped.set(row.requirementId, list);
    }
    return new Map(
      requirements.map((requirement) => {
        const workItems = grouped.get(requirement.id) ?? [];
        return [
          requirement.id,
          {
            implementation: computeImplementation(workItems.map((item) => item.status)),
            workItems,
          },
        ];
      }),
    );
  }

  /**
   * Requirement ids of a project in a given state. `not_implemented` is
   * answered as an exclusion list because most requirements have no link.
   */
  async filterFor(
    projectId: string,
    state: ImplementationState,
  ): Promise<{ in: string[] } | { notIn: string[] }> {
    const rows = await this.links.forProject(projectId);
    const statuses = new Map<string, LinkWithWorkItem['workItem']['status'][]>();
    for (const row of rows) {
      const list = statuses.get(row.requirementId) ?? [];
      list.push(row.workItem.status);
      statuses.set(row.requirementId, list);
    }
    const inState = (wanted: ImplementationState): string[] =>
      [...statuses.entries()]
        .filter(([, list]) => computeImplementation(list).state === wanted)
        .map(([id]) => id);
    if (state === 'not_implemented') {
      return {
        notIn: [...inState('partially_implemented'), ...inState('implemented')],
      };
    }
    return { in: inState(state) };
  }

  /** Link/unlink change what a requirement reports, so both sides are checked. */
  private async authorize(projectId: string): Promise<void> {
    await this.access.assertRouteAccess(projectId, 'Requirement');
    await this.access.assertPermission(projectId, 'requirements.read');
    await this.access.assertPermission(projectId, 'work_items.write');
  }
}

export function toLinkedWorkItem(row: LinkWithWorkItem): LinkedWorkItemView {
  return {
    linkId: row.id,
    linkType: row.linkType,
    workItemId: row.workItem.id,
    key: row.workItem.key,
    title: row.workItem.title,
    type: row.workItem.type,
    status: row.workItem.status,
    releaseId: row.workItem.releaseId,
    linkedAt: row.createdAt.toISOString(),
  };
}

function toLinkedRequirement(row: LinkWithRequirement): LinkedRequirementView {
  return {
    linkId: row.id,
    linkType: row.linkType,
    requirementId: row.requirement.id,
    key: row.requirement.key,
    title: row.requirement.title,
    status: row.requirement.status,
    linkedAt: row.createdAt.toISOString(),
  };
}
