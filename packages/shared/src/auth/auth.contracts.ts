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

export const refreshSchema = z.object({
  refreshToken: z.string().min(16),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

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

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRoleName;
}

export interface AuthTokens {
  accessToken: string;
  /**
   * Returned in the body rather than only in a cookie because the web client
   * is a separate origin in development. The trade-off and the cookie plan are
   * recorded in docs/security-model.md.
   */
  refreshToken: string;
  expiresIn: number;
}

export interface AuthSession extends AuthTokens {
  user: AuthenticatedUser;
  organizations: OrganizationSummary[];
}
