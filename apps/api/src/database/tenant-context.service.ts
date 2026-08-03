import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { UnauthenticatedError } from '../errors';

/**
 * Everything about "who is asking" that the lower layers need.
 *
 * It travels in an AsyncLocalStorage rather than as a parameter threaded
 * through every call, for one specific reason: a parameter can be forgotten,
 * and forgetting it here means a repository query without an organization
 * filter. Reading it from the store means the repository cannot be built
 * without it — `requireOrganizationId()` throws instead of silently returning
 * everyone's data.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  /** Filled in by the authentication guard. */
  userId?: string;
  /** The authenticated address, carried so audit lines read without a join. */
  email?: string;
  /** Filled in by the active-organization guard. */
  organizationId?: string;
  role?: OrganizationRole;
}

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  /** Runs `work` with `context` visible to everything it awaits. */
  run<T>(context: RequestContext, work: () => T): T {
    return this.storage.run(context, work);
  }

  get(): RequestContext | undefined {
    return this.storage.getStore();
  }

  /**
   * Called by the authentication guard once the access token is verified.
   * Mutating the store rather than re-running it keeps the whole request in a
   * single asynchronous context.
   */
  setUser(userId: string, email: string): void {
    const store = this.storage.getStore();
    if (store !== undefined) {
      store.userId = userId;
      store.email = email;
    }
  }

  /** Called by the active-organization guard once membership is verified. */
  setOrganization(organizationId: string, role: OrganizationRole): void {
    const store = this.storage.getStore();
    if (store !== undefined) {
      store.organizationId = organizationId;
      store.role = role;
    }
  }

  get requestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  get userId(): string | undefined {
    return this.storage.getStore()?.userId;
  }

  get email(): string | undefined {
    return this.storage.getStore()?.email;
  }

  get organizationId(): string | undefined {
    return this.storage.getStore()?.organizationId;
  }

  get role(): OrganizationRole | undefined {
    return this.storage.getStore()?.role;
  }

  /**
   * The organization every tenant-scoped query must filter by.
   *
   * Throwing is the point. A repository that reaches this method outside a
   * request — or inside a request that never resolved an organization — has a
   * bug, and the correct outcome is a 401, never an unfiltered query.
   */
  requireOrganizationId(): string {
    const organizationId = this.storage.getStore()?.organizationId;
    if (organizationId === undefined) {
      throw new UnauthenticatedError('No active organization in the request context');
    }
    return organizationId;
  }

  requireUserId(): string {
    const userId = this.storage.getStore()?.userId;
    if (userId === undefined) {
      throw new UnauthenticatedError('No authenticated user in the request context');
    }
    return userId;
  }
}
