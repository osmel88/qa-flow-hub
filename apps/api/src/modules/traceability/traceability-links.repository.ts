import { Injectable } from '@nestjs/common';
import { LinkableEntity } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

/**
 * The one write every module that owns a linkable entity needs: when the entity
 * goes, its links go with it.
 *
 * It lives in its own provider rather than in each owning repository because
 * the rule is a property of the link table, not of requirements or of defects,
 * and because a module that only needs to purge should not have to import the
 * traceability service and inherit its dependencies.
 */
@Injectable()
export class TraceabilityLinksRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  /**
   * Removes every link that touches any of `ids`, in either direction.
   *
   * The rows are deleted, not flagged: that is what removing a link by hand
   * already does, and the audit entry the caller writes is the history. Always
   * pass the caller's transaction — a purge committed while the soft delete
   * rolls back would destroy links that still have both ends.
   */
  async purgeFor(
    type: LinkableEntity,
    ids: string[],
    tx?: PrismaTransaction,
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const { count } = await (tx ?? this.prisma).traceabilityLink.deleteMany({
      where: this.scope({
        OR: [
          { sourceType: type, sourceId: { in: ids } },
          { targetType: type, targetId: { in: ids } },
        ],
      }),
    });

    return count;
  }
}
