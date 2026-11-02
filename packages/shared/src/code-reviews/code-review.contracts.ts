import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import type { DevelopmentArtifactView } from '../development/development.contracts.js';

const idSchema = z.string().min(1).max(64);

/**
 * Code review (S5-F3): an internal, provider-neutral review of a project,
 * optionally of a (local) pull request artifact and of work items. Each
 * reviewer holds one decision; the review status follows from them, except
 * `dismissed`, which closes the review.
 */
export const CODE_REVIEW_STATUSES = [
  'pending',
  'in_review',
  'changes_requested',
  'approved',
  'dismissed',
] as const;
export type CodeReviewStatus = (typeof CODE_REVIEW_STATUSES)[number];

export const CODE_REVIEW_DECISIONS = [
  'pending',
  'approved',
  'changes_requested',
  'dismissed',
] as const;
export type CodeReviewDecision = (typeof CODE_REVIEW_DECISIONS)[number];

export const CODE_REVIEW_EVENT_KINDS = [
  'created',
  'updated',
  'reviewer_added',
  'reviewer_removed',
  'approved',
  'changes_requested',
  'decision_revoked',
  'approval_dismissed',
  'dismissed',
  'commented',
  'work_item_linked',
  'work_item_unlinked',
  'deleted',
] as const;
export type CodeReviewEventKind = (typeof CODE_REVIEW_EVENT_KINDS)[number];

export const MAX_REQUIRED_APPROVALS = 20;
const requiredApprovalsSchema = z.number().int().min(1).max(MAX_REQUIRED_APPROVALS);
const commentSchema = z.string().trim().min(1).max(4000);

export const createCodeReviewSchema = z.object({
  projectId: idSchema,
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().max(4000).optional(),
  pullRequestId: idSchema.optional(),
  workItemIds: z.array(idSchema).max(50).default([]),
  reviewerIds: z.array(idSchema).max(20).default([]),
  /** Overrides the project rule for this review. */
  requiredApprovals: requiredApprovalsSchema.optional(),
});
export type CreateCodeReviewInput = z.infer<typeof createCodeReviewSchema>;

export const updateCodeReviewSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    summary: z.string().trim().max(4000).nullable().optional(),
    requiredApprovals: requiredApprovalsSchema.nullable().optional(),
    version: z.number().int().positive().optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    message: 'Nothing to update',
  });
export type UpdateCodeReviewInput = z.infer<typeof updateCodeReviewSchema>;

const userFilter = z.union([z.literal('me'), idSchema]);
export const listCodeReviewsQuerySchema = paginationQuerySchema.extend({
  projectId: idSchema,
  status: z.enum(CODE_REVIEW_STATUSES).optional(),
  reviewerId: userFilter.optional(),
  authorId: userFilter.optional(),
  workItemId: idSchema.optional(),
  pullRequestId: idSchema.optional(),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListCodeReviewsQuery = z.infer<typeof listCodeReviewsQuerySchema>;

export const codeReviewDecisionSchema = z.object({
  decision: z.enum(['approve', 'request_changes', 'revoke']),
  comment: commentSchema.optional(),
});
export type CodeReviewDecisionInput = z.infer<typeof codeReviewDecisionSchema>;

export const codeReviewCommentSchema = z.object({ comment: commentSchema });
export const optionalCommentSchema = z.object({ comment: commentSchema.optional() });
export const codeReviewReviewerSchema = z.object({ userId: idSchema });
export const codeReviewWorkItemSchema = z.object({ workItemId: idSchema });
export const codeReviewSettingsQuerySchema = z.object({ projectId: idSchema });
export const codeReviewSettingsSchema = z.object({
  projectId: idSchema,
  requiredApprovals: requiredApprovalsSchema,
});
export type CodeReviewSettingsInput = z.infer<typeof codeReviewSettingsSchema>;

export interface CodeReviewUserRef {
  id: string;
  fullName: string;
}

export interface CodeReviewReviewerView {
  user: CodeReviewUserRef;
  decision: CodeReviewDecision;
  comment: string | null;
  decidedAt: string | null;
  /** False when the reviewer lost access or the review permission. */
  canReview: boolean;
}

export const MERGE_BLOCKERS = [
  'dismissed',
  'changes_requested',
  'insufficient_approvals',
  'pull_request_not_open',
] as const;
export type MergeBlocker = (typeof MERGE_BLOCKERS)[number];

export interface MergeReadiness {
  ready: boolean;
  approvals: number;
  requiredApprovals: number;
  blockers: MergeBlocker[];
}

export interface CodeReviewSummaryView {
  id: string;
  projectId: string;
  title: string;
  status: CodeReviewStatus;
  author: CodeReviewUserRef;
  pullRequest: Pick<DevelopmentArtifactView, 'id' | 'prNumber' | 'title' | 'status' | 'url'> | null;
  reviewers: CodeReviewReviewerView[];
  mergeReadiness: MergeReadiness;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CodeReviewEventView {
  id: string;
  kind: CodeReviewEventKind;
  actor: CodeReviewUserRef | null;
  subject: CodeReviewUserRef | null;
  comment: string | null;
  createdAt: string;
}

export interface CodeReviewView extends CodeReviewSummaryView {
  summary: string | null;
  /** The value set on the review, null when the project rule applies. */
  requiredApprovals: number | null;
  provider: string;
  externalId: string | null;
  workItems: Array<{ id: string; key: string; title: string; status: string }>;
  events: CodeReviewEventView[];
}

export interface CodeReviewSettingsView {
  projectId: string;
  requiredApprovals: number;
}

/**
 * Review status from the reviewer decisions: any change request wins, then
 * enough approvals, then any decision at all (`in_review`).
 */
export function computeCodeReviewStatus(
  decisions: readonly CodeReviewDecision[],
  requiredApprovals: number,
  dismissed: boolean,
): CodeReviewStatus {
  if (dismissed) {
    return 'dismissed';
  }
  if (decisions.includes('changes_requested')) {
    return 'changes_requested';
  }
  const approvals = decisions.filter((decision) => decision === 'approved').length;
  if (approvals >= requiredApprovals) {
    return 'approved';
  }
  return decisions.some((decision) => decision !== 'pending') ? 'in_review' : 'pending';
}

/**
 * Merge readiness, derived: not dismissed, no change requested, enough
 * approvals from reviewers who can still review, and the pull request (when
 * there is one) still open or approved.
 */
export function computeMergeReadiness(input: {
  dismissed: boolean;
  reviewers: ReadonlyArray<{ decision: CodeReviewDecision; canReview: boolean }>;
  requiredApprovals: number;
  pullRequestStatus: string | null | undefined;
}): MergeReadiness {
  const counted = input.reviewers.filter((reviewer) => reviewer.canReview);
  const approvals = counted.filter((reviewer) => reviewer.decision === 'approved').length;
  const blockers: MergeBlocker[] = [];
  if (input.dismissed) {
    blockers.push('dismissed');
  }
  if (counted.some((reviewer) => reviewer.decision === 'changes_requested')) {
    blockers.push('changes_requested');
  }
  if (approvals < input.requiredApprovals) {
    blockers.push('insufficient_approvals');
  }
  if (
    input.pullRequestStatus !== undefined &&
    input.pullRequestStatus !== null &&
    !['open', 'approved'].includes(input.pullRequestStatus)
  ) {
    blockers.push('pull_request_not_open');
  }
  return {
    ready: blockers.length === 0,
    approvals,
    requiredApprovals: input.requiredApprovals,
    blockers,
  };
}
