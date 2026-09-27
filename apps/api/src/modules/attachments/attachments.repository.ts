import { Injectable } from '@nestjs/common';
import { AttachmentMetadata, LinkableEntity } from '@prisma/client';
import { AttachableEntity } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export type AttachmentRow = AttachmentMetadata & {
  uploadedBy: { fullName: string } | null;
};

export interface AttachmentDraft {
  projectId: string;
  entityType: AttachableEntity;
  entityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  storageProvider: string;
  storageKey: string;
  uploadedById: string;
}

const WITH_UPLOADER = { uploadedBy: { select: { fullName: true } } } as const;

@Injectable()
export class AttachmentsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  /**
   * The project an entity belongs to, or `null` when it does not exist, is
   * soft-deleted or belongs to another organization — the three cases are
   * indistinguishable on purpose, so a probe cannot tell one from the other.
   * A result has no project of its own; its run's is the answer.
   */
  async resolveProject(entityType: AttachableEntity, entityId: string): Promise<string | null> {
    switch (entityType) {
      case 'test_result': {
        const result = await this.prisma.testResult.findFirst({
          where: this.scope({ id: entityId, testRun: { deletedAt: null } }),
          select: { testRun: { select: { projectId: true } } },
        });
        return result?.testRun.projectId ?? null;
      }
      case 'test_run': {
        const run = await this.prisma.testRun.findFirst({
          where: this.active({ id: entityId }),
          select: { projectId: true },
        });
        return run?.projectId ?? null;
      }
      case 'test_case': {
        const testCase = await this.prisma.testCase.findFirst({
          where: this.active({ id: entityId }),
          select: { projectId: true },
        });
        return testCase?.projectId ?? null;
      }
      case 'defect': {
        const defect = await this.prisma.defect.findFirst({
          where: this.active({ id: entityId }),
          select: { projectId: true },
        });
        return defect?.projectId ?? null;
      }
    }
  }

  create(draft: AttachmentDraft, tx?: PrismaTransaction): Promise<AttachmentRow> {
    return (tx ?? this.prisma).attachmentMetadata.create({
      data: { ...draft, organizationId: this.organizationId },
      include: WITH_UPLOADER,
    });
  }

  findActiveById(id: string): Promise<AttachmentRow | null> {
    return this.prisma.attachmentMetadata.findFirst({
      where: this.active({ id }),
      include: WITH_UPLOADER,
    });
  }

  listFor(entityType: LinkableEntity, entityId: string): Promise<AttachmentRow[]> {
    return this.prisma.attachmentMetadata.findMany({
      where: this.active({ entityType, entityId }),
      include: WITH_UPLOADER,
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Marks the row deleted; `false` when it was already gone (a lost race). */
  async softDelete(id: string): Promise<boolean> {
    const result = await this.prisma.attachmentMetadata.updateMany({
      where: this.active({ id }),
      data: { deletedAt: new Date() },
    });
    return result.count === 1;
  }
}
