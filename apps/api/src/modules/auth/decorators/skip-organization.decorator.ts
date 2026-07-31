import { SetMetadata } from '@nestjs/common';

export const SKIP_ORGANIZATION_KEY = 'skipOrganization';

/**
 * For authenticated endpoints that exist *above* the tenant boundary: the
 * profile, the list of organizations you belong to, and creating the first one.
 * Requiring an active organization there would be a chicken-and-egg problem.
 */
export const SkipOrganization = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_ORGANIZATION_KEY, true);
