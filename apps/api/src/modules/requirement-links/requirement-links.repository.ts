import { Injectable } from '@nestjs/common';
import {
  Requirement,
  RequirementLinkType,
  RequirementWorkItemLink,
  WorkItem,
} from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export type LinkWithWorkItem = RequirementWorkItemLink & { workItem: WorkItem };
export type LinkWithRequirement = RequirementWorkItemLink & { requirement: Requirement };

interface LockedRow {
  id: string;
  projectId: string;
  key: string;
}

/** Requirement ↔ work item links (S4-F4). Deleted ends are never returned. */
@Injectable()
export class RequirementLinksRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  /**
   * Share-locks a live requirement until the caller commits, so a concurrent
   * soft delete waits for the link (or the link sees the delete and fails).
   */
  async lockRequirement(id: string, tx: PrismaTransaction): Promise<LockedRow | null> {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT "id", "projectId", "key" FROM "requirements"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
      FOR SHARE
    `;
    return rows[0] ?? null;
  }

  async lockWorkItem(id: string, tx: PrismaTransaction): Promise<LockedRow | null> {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT "id", "projectId", "key" FROM "work_items"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
      FOR SHARE
    `;
    return rows[0] ?? null;
  }

  /** Inserts unless the link exists; true when a row was created. */
  async insert(
    data: {
      projectId: string;
      requirementId: string;
      workItemId: string;
      linkType: RequirementLinkType;
      createdById: string;
    },
    tx: PrismaTransaction,
  ): Promise<boolean> {
    const { count } = await tx.requirementWorkItemLink.createMany({
      data: [{ ...data, organizationId: this.organizationId }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  find(
    requirementId: string,
    workItemId: string,
    linkType: RequirementLinkType,
    tx: PrismaTransaction,
  ): Promise<RequirementWorkItemLink | null> {
    return tx.requirementWorkItemLink.findFirst({
      where: { organizationId: this.organizationId, requirementId, workItemId, linkType },
    });
  }

  async remove(
    requirementId: string,
    workItemId: string,
    linkType: RequirementLinkType,
    tx: PrismaTransaction,
  ): Promise<string | null> {
    const existing = await this.find(requirementId, workItemId, linkType, tx);
    if (existing === null) {
      return null;
    }
    const { count } = await tx.requirementWorkItemLink.deleteMany({
      where: { organizationId: this.organizationId, id: existing.id },
    });
    return count === 1 ? existing.id : null;
  }

  /** Links of these requirements to live work items, in backlog order. */
  forRequirements(requirementIds: readonly string[]): Promise<LinkWithWorkItem[]> {
    if (requirementIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.requirementWorkItemLink.findMany({
      where: {
        organizationId: this.organizationId,
        requirementId: { in: [...requirementIds] },
        workItem: { deletedAt: null },
      },
      include: { workItem: true },
      orderBy: [{ workItem: { rank: 'asc' } }, { id: 'asc' }],
    });
  }

  /** Every link of a project to live work items and live requirements. */
  forProject(projectId: string): Promise<LinkWithWorkItem[]> {
    return this.prisma.requirementWorkItemLink.findMany({
      where: {
        organizationId: this.organizationId,
        projectId,
        workItem: { deletedAt: null },
        requirement: { deletedAt: null },
      },
      include: { workItem: true },
      orderBy: [{ workItem: { rank: 'asc' } }, { id: 'asc' }],
    });
  }

  forWorkItem(workItemId: string): Promise<LinkWithRequirement[]> {
    return this.prisma.requirementWorkItemLink.findMany({
      where: {
        organizationId: this.organizationId,
        workItemId,
        requirement: { deletedAt: null },
      },
      include: { requirement: true },
      orderBy: [{ requirement: { key: 'asc' } }],
    });
  }
}
