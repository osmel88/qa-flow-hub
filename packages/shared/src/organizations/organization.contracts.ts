import { z } from 'zod';
import { emailSchema } from '../auth/auth.contracts.js';
import { paginationQuerySchema } from '../common/pagination.js';

export const ORGANIZATION_PLANS = ['free', 'team', 'business'] as const;
export const ORGANIZATION_ROLES_INPUT = [
  'organization_owner',
  'organization_admin',
  'project_manager',
  'qa_lead',
  'tester',
  'viewer',
] as const;

/**
 * A slug is part of a URL, so it is constrained rather than sanitised: an
 * allow-list of lowercase letters, digits and single hyphens. Sanitising
 * arbitrary input into a slug produces surprises ("Ünïcode" → "nicode"); asking
 * for a valid one produces a clear error.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens');

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  plan: z.enum(ORGANIZATION_PLANS).optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

/**
 * Inviting an owner is not offered. Ownership transfer is a separate, explicit
 * operation; letting it happen through an invitation form is how organizations
 * end up with owners nobody meant to create.
 */
export const invitableRoleSchema = z.enum([
  'organization_admin',
  'project_manager',
  'qa_lead',
  'tester',
  'viewer',
]);

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: invitableRoleSchema,
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(16).max(256),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const updateMemberSchema = z.object({
  role: z.enum(ORGANIZATION_ROLES_INPUT),
});
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const listMembersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  plan: (typeof ORGANIZATION_PLANS)[number];
  createdAt: string;
}

export interface MemberView {
  userId: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  role: (typeof ORGANIZATION_ROLES_INPUT)[number];
  status: 'active' | 'suspended';
  joinedAt: string;
}

export interface InvitationView {
  id: string;
  email: string;
  role: z.infer<typeof invitableRoleSchema>;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  resendCount: number;
  lastSentAt: string;
  createdAt: string;
}

/**
 * The plaintext token is returned **once**, at creation, and never stored.
 * Until email delivery exists this is how an invitation reaches a person; the
 * field is documented as temporary in docs/integrations-roadmap.md.
 */
export interface CreatedInvitationView extends InvitationView {
  token: string;
  acceptUrl: string;
}
