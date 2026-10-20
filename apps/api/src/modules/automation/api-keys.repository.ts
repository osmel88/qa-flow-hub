import { Injectable } from '@nestjs/common';
import { ApiKey, Prisma } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

@Injectable()
export class ApiKeysRepository extends TenantAwareRepository {
  constructor(
    private readonly base: PrismaService,
    tenant: TenantContextService,
  ) {
    super(base, tenant);
  }

  create(
    data: Omit<Prisma.ApiKeyUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<ApiKey> {
    return tx.apiKey.create({ data: { ...data, organizationId: this.organizationId } });
  }

  list(projectId: string): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({
      where: this.scope({ projectId }),
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  findInProject(projectId: string, id: string, tx?: PrismaTransaction): Promise<ApiKey | null> {
    return (tx ?? this.prisma).apiKey.findFirst({ where: this.scope({ id, projectId }) });
  }

  findByPrefix(prefix: string): Promise<ApiKey | null> {
    return this.prisma.apiKey.findFirst({ where: this.scope({ prefix }) });
  }

  countActive(projectId: string, now: Date, tx: PrismaTransaction): Promise<number> {
    return tx.apiKey.count({
      where: this.scope({
        projectId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      }),
    });
  }

  /** Only revokes a key that is still active; returns whether this call did it. */
  async revoke(id: string, userId: string, now: Date, tx: PrismaTransaction): Promise<boolean> {
    const { count } = await tx.apiKey.updateMany({
      where: this.scope({ id, revokedAt: null }),
      data: { revokedAt: now, revokedById: userId },
    });
    return count === 1;
  }

  /**
   * Re-reads the key inside the ingestion transaction with a share lock. A
   * revocation (an UPDATE) waits for in-flight ingestions and every later one
   * sees it: once revoke returns, no report can be recorded with the key.
   */
  async lockForUse(
    id: string,
    tx: PrismaTransaction,
  ): Promise<{ revokedAt: Date | null; expiresAt: Date | null } | null> {
    const rows = await tx.$queryRaw<Array<{ revokedAt: Date | null; expiresAt: Date | null }>>`
      SELECT "revokedAt", "expiresAt" FROM "api_keys"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
      FOR SHARE
    `;
    return rows[0] ?? null;
  }

  /**
   * Waits for every in-flight ingestion holding the key (`lockForUse`), so the
   * revocation time read afterwards is later than any report they record.
   */
  async lockForRevoke(id: string, tx: PrismaTransaction): Promise<void> {
    await tx.$queryRaw`
      SELECT "id" FROM "api_keys"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
      FOR UPDATE
    `;
  }

  async touch(id: string, now: Date, tx: PrismaTransaction): Promise<void> {
    await tx.apiKey.updateMany({ where: this.scope({ id }), data: { lastUsedAt: now } });
  }

  async lockProjectKeys(projectId: string, tx: PrismaTransaction): Promise<void> {
    const key = `api-keys:${projectId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /**
   * The organization that owns a prefix, through a SECURITY DEFINER function
   * that can answer nothing else: the request has no tenant yet, so RLS would
   * hide the row. The secret is verified afterwards, under RLS.
   */
  async organizationForPrefix(prefix: string): Promise<string | null> {
    const rows = await this.base.$queryRaw<Array<{ organization_id: string | null }>>`
      SELECT api_key_organization_for_prefix(${prefix}) AS organization_id
    `;
    return rows[0]?.organization_id ?? null;
  }
}
