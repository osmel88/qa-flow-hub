import { z } from 'zod';

/**
 * Password policy.
 *
 * Length first, composition second. Length is what actually resists offline
 * cracking; the character-class rules are here because customers expect them
 * and because they stop the most obvious dictionary entries. The upper bound
 * is not cosmetic: argon2 hashes whatever it is given, and an unbounded
 * password is a cheap way to burn CPU on a login endpoint.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a digit');

/**
 * Emails are normalised at the edge, not deep in a service: lower-cased and
 * trimmed here means the database unique index is an effective
 * case-insensitive constraint with no functional index.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('A valid email address is required')
  .max(254);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(120),
  /**
   * Optional invitation token, for the "somebody invited me and I have no
   * account yet" path. Signing up and joining have to be one request: two would
   * leave a user stranded with an account and no organization if the second
   * failed, and would ask them to paste a token they were never shown.
   */
  invitationToken: z.string().min(16).max(256).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // No policy check on login: the stored password may predate a policy change,
  // and telling an attacker that a password is "too short" is information.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * The refresh token normally travels in an `HttpOnly` cookie the browser sends
 * on its own, so the body is optional. It stays supported for clients without a
 * cookie jar — CI scripts, integration tests, future server-to-server callers —
 * which ask for it explicitly with the `X-Refresh-Transport: body` header.
 */
export const refreshSchema = z.object({
  refreshToken: z.string().min(16).optional(),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

/** Header a non-browser client sends to get the refresh token in the body. */
export const REFRESH_TRANSPORT_HEADER = 'x-refresh-transport';
export const REFRESH_COOKIE_NAME = 'qafh_refresh';

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'The new password must be different from the current one',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  avatarUrl: z.string().url().max(2048).nullish(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const ORGANIZATION_ROLES = [
  'organization_owner',
  'organization_admin',
  'project_manager',
  'qa_lead',
  'tester',
  'viewer',
] as const;
export type OrganizationRoleName = (typeof ORGANIZATION_ROLES)[number];

/**
 * Role hierarchy, lower being more powerful. Shared so the API and the client
 * cannot drift: the server enforces it, and the client uses it to avoid
 * offering an action the server is going to refuse.
 */
export const ROLE_RANK: Record<OrganizationRoleName, number> = {
  organization_owner: 0,
  organization_admin: 1,
  project_manager: 2,
  qa_lead: 3,
  tester: 4,
  viewer: 5,
};

/** True when `actor` is at least as powerful as `other`. */
export function outranksOrEquals(
  actor: OrganizationRoleName,
  other: OrganizationRoleName,
): boolean {
  return ROLE_RANK[actor] <= ROLE_RANK[other];
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
}

/**
 * Organization-level actions and the roles allowed to perform them: the single
 * source for both the API guards (`@Roles(...ORGANIZATION_CAPABILITY_ROLES.x)`
 * and the services that check a role) and the session's `capabilities`, which
 * the Web reads to enable or explain a control. The API stays the boundary.
 */
export const ORGANIZATION_CAPABILITY_ROLES = {
  /** `POST /projects`. */
  createProjects: ['organization_owner', 'organization_admin'],
  /** `PATCH /organizations/current` (name, MFA policy). */
  manageOrganization: ['organization_owner'],
  /** Members and invitations of `/organizations/current`. */
  manageMembers: ['organization_owner', 'organization_admin'],
  /** `GET /billing/overview` and usage. */
  readBilling: ['organization_owner', 'organization_admin'],
  /** Plan changes, cancel, resume, mock checkout. */
  manageBilling: ['organization_owner'],
  /** `GET /audit-log`. */
  readAuditLog: ['organization_owner', 'organization_admin'],
  /** Organization-wide notification deliveries. */
  inspectNotifications: ['organization_owner', 'organization_admin'],
  /** Every project without a project grant. */
  seeEveryProject: ['organization_owner', 'organization_admin'],
} as const satisfies Record<string, readonly OrganizationRoleName[]>;

export type OrganizationCapability = keyof typeof ORGANIZATION_CAPABILITY_ROLES;
export type OrganizationCapabilities = Record<OrganizationCapability, boolean>;

export function hasOrganizationCapability(
  role: OrganizationRoleName,
  capability: OrganizationCapability,
): boolean {
  return (ORGANIZATION_CAPABILITY_ROLES[capability] as readonly OrganizationRoleName[]).includes(
    role,
  );
}

export function organizationCapabilities(role: OrganizationRoleName): OrganizationCapabilities {
  const entries = (Object.keys(ORGANIZATION_CAPABILITY_ROLES) as OrganizationCapability[]).map(
    (capability) => [capability, hasOrganizationCapability(role, capability)] as const,
  );
  return Object.fromEntries(entries) as OrganizationCapabilities;
}

/** Kept for readability at the call sites that only care about projects. */
export const PROJECT_CREATOR_ROLES = ORGANIZATION_CAPABILITY_ROLES.createProjects;

export function canCreateProjects(role: OrganizationRoleName): boolean {
  return hasOrganizationCapability(role, 'createProjects');
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRoleName;
  /** S3-F6: members need an MFA-verified session to act in it. */
  requireMfa: boolean;
  /** Optional so sessions stored by an older client still parse. */
  capabilities?: OrganizationCapabilities;
}

export const MEMBERSHIP_STATUSES = ['active', 'suspended'] as const;
export type MembershipStatusName = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * One of the caller's memberships as `GET /auth/memberships` returns it.
 * Unlike the session's `organizations`, suspended memberships are included.
 */
export interface MembershipView {
  organizationId: string;
  organizationName: string;
  role: OrganizationRoleName;
  status: MembershipStatusName;
}

export interface AuthTokens {
  accessToken: string;
  /**
   * `null` for browsers: the token was set as an `HttpOnly` cookie and script
   * on the page must not be able to read it. Only clients that asked for
   * `X-Refresh-Transport: body` get the value here.
   */
  refreshToken: string | null;
  expiresIn: number;
}

export interface AuthSession extends AuthTokens {
  user: AuthenticatedUser;
  organizations: OrganizationSummary[];
}
