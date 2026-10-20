import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';

export const NOTIFICATION_TYPES = [
  'organization_invitation',
  'password_changed',
  'test_run_assignment',
  'defect_assignment',
  'defect_status_changed',
  'test_run_failed',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * Which preference, if any, gates a type. Security and onboarding messages
 * have none: a person who turned every email off still has to learn that
 * their password changed, and an invitee has no account to hold a preference.
 */
export const NOTIFICATION_CATEGORIES = [
  'security',
  'onboarding',
  'test_run_assignments',
  'defect_assignments',
  'status_changes',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CATEGORY_BY_TYPE: Record<NotificationType, NotificationCategory> = {
  organization_invitation: 'onboarding',
  password_changed: 'security',
  test_run_assignment: 'test_run_assignments',
  defect_assignment: 'defect_assignments',
  defect_status_changed: 'status_changes',
  test_run_failed: 'status_changes',
};

export const OPTIONAL_NOTIFICATION_CATEGORIES = [
  'test_run_assignments',
  'defect_assignments',
  'status_changes',
] as const satisfies readonly NotificationCategory[];
export type OptionalNotificationCategory = (typeof OPTIONAL_NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_SKIP_REASONS = [
  'email_disabled',
  'category_disabled',
  'recipient_inactive',
  'recipient_no_access',
  'duplicate',
] as const;
export type NotificationSkipReason = (typeof NOTIFICATION_SKIP_REASONS)[number];

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);

export const listNotificationsQuerySchema = paginationQuerySchema.extend({
  type: notificationTypeSchema.optional(),
  status: notificationStatusSchema.optional(),
  /**
   * `mine` (default) lists what was addressed to the caller. `organization`
   * lists every message of the active organization and is reserved to owners
   * and admins: it is the operator's view of what left the product.
   */
  scope: z.enum(['mine', 'organization']).default('mine'),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const updateNotificationPreferencesSchema = z
  .object({
    emailEnabled: z.boolean().optional(),
    testRunAssignments: z.boolean().optional(),
    defectAssignments: z.boolean().optional(),
    statusChanges: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;

export interface NotificationPreferencesView {
  emailEnabled: boolean;
  testRunAssignments: boolean;
  defectAssignments: boolean;
  statusChanges: boolean;
  updatedAt: string | null;
}

/** What the API returns about a message: the fact and its fate, never the body. */
export interface NotificationView {
  id: string;
  type: NotificationType;
  category: NotificationCategory;
  channel: 'email';
  recipientEmail: string;
  recipientUserId: string | null;
  subject: string;
  status: NotificationStatus;
  provider: string | null;
  attempts: number;
  createdAt: string;
  attemptedAt: string | null;
  /** When the outbox worker will try again; null once delivered, skipped or given up. */
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  failureReason: string | null;
  skipReason: string | null;
  metadata: Record<string, string>;
}

/**
 * A message the mock provider captured, as the development outbox shows it.
 * Links are redacted: an invitation link *is* the invitation, and the outbox
 * is readable by every owner and admin of the organization.
 */
export interface MockEmailPreview {
  notificationId: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  capturedAt: string;
}

export interface EmailProviderView {
  provider: string;
  mode: 'mock' | 'real';
  /** True while the provider captures messages instead of delivering them. */
  inspectable: boolean;
  fromAddress: string;
}
