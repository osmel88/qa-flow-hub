import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantContextService } from '../../database/tenant-context.service';

export interface AuditEntry {
  action: AuditAction;
  entityType: string;
  entityId: string;
  /** One line a human can read in a list without expanding anything. */
  summary: string;
  /** Structured before/after. Must never contain secrets. */
  changes?: Prisma.InputJsonValue;
  /** Overrides the organization from the context (e.g. login, which has none). */
  organizationId?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly context: TenantContextService,
  ) {}

  /**
   * Records an action. Append-only: there is no update or delete, by design and
   * by the absence of the methods.
   *
   * Pass `tx` when the entry must live or die with the operation it describes —
   * which is most of the time. An audit log claiming a project was created when
   * the transaction rolled back is worse than no audit log, because it will be
   * believed.
   */
  async record(entry: AuditEntry, tx?: PrismaTransaction): Promise<void> {
    const request = this.context.get();
    const organizationId =
      entry.organizationId === undefined ? (request?.organizationId ?? null) : entry.organizationId;

    try {
      await (tx ?? this.prisma).auditLog.create({
        data: {
          organizationId,
          userId: request?.userId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          summary: entry.summary,
          ...(entry.changes === undefined ? {} : { changes: entry.changes }),
          ipAddress: request?.ipAddress ?? null,
          userAgent: request?.userAgent ?? null,
          requestId: request?.requestId ?? null,
        },
      });
    } catch (error: unknown) {
      // Outside a transaction, a failed audit write must not fail the user's
      // operation: the action already happened, and hiding it behind a 500
      // would be a worse outcome than an incomplete log. Inside a transaction
      // the error propagates, which is the correct behaviour there.
      if (tx !== undefined) {
        throw error;
      }
      this.logger.error(
        `Failed to write audit entry ${entry.action} for ${entry.entityType}:${entry.entityId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
