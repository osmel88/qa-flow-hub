import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'qa-flow-hub:isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is applied globally, so the default for any new endpoint is
 * "protected". Opening a route is an explicit, greppable decision — the
 * opposite default (opt-in protection) is how endpoints end up public by
 * accident.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
