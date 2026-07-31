import { PaginationQuery, toSkipTake } from '@qa-flow-hub/shared';
import { PrismaService } from './prisma.service';
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
 */
export abstract class TenantAwareRepository {
  protected constructor(
    protected readonly prisma: PrismaService,
    protected readonly tenant: TenantContextService,
  ) {}

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
