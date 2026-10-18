import { z } from 'zod';
import { ORGANIZATION_ROLES, OrganizationRoleName } from '../auth/auth.contracts.js';
import { paginationQuerySchema } from '../common/pagination.js';

export const PROJECT_STATUSES = ['active', 'archived'] as const;

/**
 * The project key is the prefix of every human-readable identifier in the
 * project (`WEB-C-102`), so it is short, uppercase and immutable after
 * creation: changing it would orphan every key anybody has ever written in a
 * ticket, a chat message or a release note.
 */
export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(8)
  .regex(/^[A-Z][A-Z0-9]*$/, 'Use 2 to 8 characters: letters and digits, starting with a letter');

export const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  key: projectKeySchema,
  description: z.string().trim().max(2000).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * `status` is absent on purpose: archiving is a transition with rules (it sets
 * `archivedAt`, and an archived project rejects writes), not a field somebody
 * types. It has its own endpoints, `POST /projects/:id/archive` and
 * `/restore`, so the audit trail records the intent rather than a diff.
 */
export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(2000).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const listProjectsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PROJECT_STATUSES).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

/**
 * A project grant *narrows or widens the organization role for one project*,
 * it does not create a second, parallel role system. Anything absent from
 * `project_members` falls back to the organization role, which is why the MVP
 * needs no migration to adopt this: a project with no grants behaves exactly as
 * it did before.
 */
/**
 * A grant is what makes a project visible to a member who is not an owner or
 * admin. `role: null` gives access with the member's organization role;
 * a role narrows or raises it inside this project.
 */
export const grantProjectRoleSchema = z.object({
  userId: z.string().trim().min(1).max(64),
  role: z.enum(ORGANIZATION_ROLES).nullable(),
});
export type GrantProjectRoleInput = z.infer<typeof grantProjectRoleSchema>;

export const updateProjectRoleSchema = z.object({
  role: z.enum(ORGANIZATION_ROLES),
});
export type UpdateProjectRoleInput = z.infer<typeof updateProjectRoleSchema>;

export interface ProjectMemberView {
  userId: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  organizationRole: OrganizationRoleName;
  /** `null` when there is no grant or the grant keeps the organization role. */
  projectRole: OrganizationRoleName | null;
  /**
   * Whether this person can see the project at all: owners and admins always,
   * everybody else only with a grant.
   */
  hasAccess: boolean;
  /** What the API will actually enforce inside this project; `null` without access. */
  effectiveRole: OrganizationRoleName | null;
  grantedAt: string | null;
}

export interface ProjectView {
  id: string;
  name: string;
  key: string;
  description: string | null;
  status: (typeof PROJECT_STATUSES)[number];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
