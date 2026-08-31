import { SetMetadata } from '@nestjs/common';

export const PROJECT_SCOPED_KEY = 'projectScoped';

/**
 * Marks a route whose authorization is completed inside the service, once the
 * project the request touches is known.
 *
 * It exists because of an ordering problem that has no clean solution in a
 * guard: for most routes the project is a property of the entity being touched
 * (`PATCH /test-cases/:id`), so no guard can know it without loading that
 * entity. Without this marker the roles guard would refuse an organization
 * `tester` who leads QA in one project before anybody could look at the grant.
 *
 * The contract this decorator signs is precise, and worth stating because
 * violating it is a privilege bug: a route marked project-scoped **must** reach
 * `ProjectAccessService.assertRouteAccess()` before it writes anything. The
 * guard only decides that *some* project could allow the action; the service
 * decides whether *this* one does.
 */
export const ProjectScoped = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PROJECT_SCOPED_KEY, true);
