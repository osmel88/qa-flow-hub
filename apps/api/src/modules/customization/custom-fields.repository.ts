import { Injectable } from '@nestjs/common';
import { CustomFieldDefinition, CustomFieldEntity, DefectWorkflow, Prisma } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

@Injectable()
export class CustomFieldsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  findById(id: string, tx?: PrismaTransaction): Promise<CustomFieldDefinition | null> {
    return (tx ?? this.prisma).customFieldDefinition.findFirst({ where: this.scope({ id }) });
  }

  list(
    projectId: string,
    entityType: CustomFieldEntity | undefined,
    includeArchived: boolean,
    tx?: PrismaTransaction,
  ): Promise<CustomFieldDefinition[]> {
    return (tx ?? this.prisma).customFieldDefinition.findMany({
      where: this.scope({
        projectId,
        ...(entityType === undefined ? {} : { entityType }),
        ...(includeArchived ? {} : { archivedAt: null }),
      }),
      orderBy: [{ entityType: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  countActive(
    projectId: string,
    entityType: CustomFieldEntity,
    tx: PrismaTransaction,
  ): Promise<number> {
    return tx.customFieldDefinition.count({
      where: this.scope({ projectId, entityType, archivedAt: null }),
    });
  }

  create(
    data: Omit<Prisma.CustomFieldDefinitionUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<CustomFieldDefinition> {
    return tx.customFieldDefinition.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }

  async update(
    id: string,
    data: Prisma.CustomFieldDefinitionUpdateManyMutationInput,
    tx: PrismaTransaction,
  ): Promise<CustomFieldDefinition | null> {
    const { count } = await tx.customFieldDefinition.updateMany({
      where: this.scope({ id }),
      data,
    });
    return count === 0 ? null : tx.customFieldDefinition.findFirst({ where: this.scope({ id }) });
  }

  /**
   * Serialises every write of one entity type's values against changes to its
   * definitions: entity writes take `FOR SHARE` on the definitions they
   * validate against, definition edits take `FOR UPDATE` on the one they
   * change. An option archived, or a field made required, at the same moment
   * as a write is therefore either seen by it or applied after it.
   */
  async lockForValues(
    projectId: string,
    entityType: CustomFieldEntity,
    tx: PrismaTransaction,
  ): Promise<CustomFieldDefinition[]> {
    await tx.$queryRaw`
      SELECT "id" FROM "custom_field_definitions"
      WHERE "organizationId" = ${this.organizationId} AND "projectId" = ${projectId}
        AND "entityType" = ${entityType}::"CustomFieldEntity"
      FOR SHARE`;
    return this.list(projectId, entityType, true, tx);
  }

  async lockForUpdate(id: string, tx: PrismaTransaction): Promise<CustomFieldDefinition | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "custom_field_definitions"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
      FOR UPDATE`;
    return rows.length === 0 ? null : this.findById(id, tx);
  }

  // --- Defect workflow -----------------------------------------------------

  findWorkflow(projectId: string, tx?: PrismaTransaction): Promise<DefectWorkflow | null> {
    return (tx ?? this.prisma).defectWorkflow.findFirst({ where: this.scope({ projectId }) });
  }

  /** `FOR SHARE` for a transition, `FOR UPDATE` for a reconfiguration. */
  async lockWorkflow(
    projectId: string,
    mode: 'share' | 'update',
    tx: PrismaTransaction,
  ): Promise<DefectWorkflow | null> {
    if (mode === 'update') {
      await tx.$queryRaw`
        SELECT "id" FROM "defect_workflows"
        WHERE "projectId" = ${projectId} AND "organizationId" = ${this.organizationId}
        FOR UPDATE`;
    } else {
      await tx.$queryRaw`
        SELECT "id" FROM "defect_workflows"
        WHERE "projectId" = ${projectId} AND "organizationId" = ${this.organizationId}
        FOR SHARE`;
    }
    return this.findWorkflow(projectId, tx);
  }

  createWorkflow(
    projectId: string,
    transitions: Prisma.InputJsonValue,
    userId: string,
    tx: PrismaTransaction,
  ): Promise<DefectWorkflow> {
    return tx.defectWorkflow.create({
      data: {
        organizationId: this.organizationId,
        projectId,
        transitions,
        updatedById: userId,
      },
    });
  }

  async updateWorkflow(
    projectId: string,
    expectedVersion: number,
    transitions: Prisma.InputJsonValue,
    userId: string,
    tx: PrismaTransaction,
  ): Promise<DefectWorkflow | null> {
    const { count } = await tx.defectWorkflow.updateMany({
      where: this.scope({ projectId, version: expectedVersion }),
      data: { transitions, updatedById: userId, version: { increment: 1 } },
    });
    return count === 0 ? null : this.findWorkflow(projectId, tx);
  }
}
