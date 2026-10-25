import { PaginationQuery, toSkipTake } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction, RlsPrismaClient } from './prisma.service';
import { TenantContextService } from './tenant-context.service';

/**
 * Base class for every repository that touches tenant data.
 *
 * It deliberately does NOT implement generic CRUD. A generic `findAll<T>()`
 * over a union of Prisma delegates can only be written by erasing the types,
 * and erasing the types in the one layer whose job is correctness is a bad
 * trade. What it provides instead are the two helpers that are easy to forget
 * and fatal to forget:
 *
 *   - `scope()`   adds `organizationId` to a where clause;
 *   - `active()`  adds `organizationId` and excludes soft-deleted rows.
 *
 * Subclasses use the fully typed Prisma delegate and pass their where clause
 * through one of them. The rule "no service touches Prisma directly" plus
 * "every repository query goes through scope()" is what makes tenant isolation
 * auditable by reading, and it is covered by test/tenancy.int-spec.ts.
 *
 * This is the *first* layer. The second is Row Level Security in PostgreSQL,
 * reached through `this.prisma`: subclasses get the client that announces the
 * active organization to the database, so a query that forgot `scope()` returns
 * nothing instead of another tenant's rows. Two layers, because a filter that
 * only exists in application code is one forgotten line away from a leak.
 */
export abstract class TenantAwareRepository {
  protected constructor(
    private readonly prismaService: PrismaService,
    protected readonly tenant: TenantContextService,
  ) {}

  /**
   * The tenant-scoped client. Deliberately the same shape as `PrismaService`,
   * so subclasses read the same as before and cannot accidentally choose the
   * unguarded client.
   *
   * Typed as `PrismaTransaction`: the RLS extension only hooks queries and
   * changes no model signature, and repositories write `(tx ?? this.prisma)`
   * everywhere. With the extended type that union makes TypeScript compare two
   * client types model by model, which exceeds its stack depth as the schema
   * grows (it did when S4-F1 added `work_items`) and breaks every such call.
   */
  protected get prisma(): PrismaTransaction {
    return this.prismaService.scoped as unknown as PrismaTransaction;
  }

  /** The same client with `$transaction`, for the few repositories that open their own. */
  protected get rlsClient(): RlsPrismaClient {
    return this.prismaService.scoped;
  }

  /** The active organization, or a 401 if there is none. */
  protected get organizationId(): string {
    return this.tenant.requireOrganizationId();
  }

  /**
   * Adds the tenant filter to a where clause.
   *
   * `organizationId` is placed last on purpose: a caller cannot override it by
   * passing their own, which is exactly the attack this layer exists to stop.
   */
  protected scope<W extends object>(where?: W): W & { organizationId: string } {
    return { ...(where ?? ({} as W)), organizationId: this.organizationId };
  }

  /** Tenant filter plus "not soft deleted". */
  protected active<W extends object>(where?: W): W & { organizationId: string; deletedAt: null } {
    return { ...(where ?? ({} as W)), organizationId: this.organizationId, deletedAt: null };
  }

  /** Translates a validated pagination query into Prisma's skip/take. */
  protected page(query: PaginationQuery): { skip: number; take: number } {
    return toSkipTake(query);
  }
}
