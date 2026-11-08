import { z } from 'zod';

/**
 * Release approvals (S6-F4). Approval rules say which kinds of approval a
 * release needs (project-wide or for one environment) and how many; the
 * decisions are an append-only history (revoking marks a decision revoked).
 * The workflow state is derived from rules + live decisions on every read.
 */
export const APPROVAL_TYPES = ['qa', 'product', 'engineering', 'release_manager'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_TYPE_LABELS: Record<ApprovalType, string> = {
  qa: 'QA',
  product: 'Product',
  engineering: 'Engineering',
  release_manager: 'Release Manager',
};

export const APPROVAL_DECISIONS = ['approved', 'rejected', 'changes_requested'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'changes_requested'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

const idSchema = z.string().min(1).max(64);

export const createApprovalRuleSchema = z.object({
  projectId: idSchema,
  /** Without it the rule applies to the release everywhere. */
  environmentId: idSchema.optional(),
  type: z.enum(APPROVAL_TYPES),
  requiredApprovals: z.number().int().min(1).max(10).default(1),
  /** Whether the creator of the release may give this approval. */
  allowSelfApproval: z.boolean().default(false),
});
export type CreateApprovalRuleInput = z.infer<typeof createApprovalRuleSchema>;

export const updateApprovalRuleSchema = z
  .object({
    requiredApprovals: z.number().int().min(1).max(10).optional(),
    allowSelfApproval: z.boolean().optional(),
    enabled: z.boolean().optional(),
    version: z.number().int().min(1).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'Nothing to update');
export type UpdateApprovalRuleInput = z.infer<typeof updateApprovalRuleSchema>;

export const listApprovalRulesQuerySchema = z.object({ projectId: idSchema });
export type ListApprovalRulesQuery = z.infer<typeof listApprovalRulesQuerySchema>;

export const releaseApprovalsQuerySchema = z.object({
  /** Without it only project-wide rules and release-wide decisions count. */
  environmentId: idSchema.optional(),
});
export type ReleaseApprovalsQuery = z.infer<typeof releaseApprovalsQuerySchema>;

export const APPROVAL_ACTIONS = ['approve', 'reject', 'request_changes'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export const APPROVAL_ACTION_DECISION: Record<ApprovalAction, ApprovalDecision> = {
  approve: 'approved',
  reject: 'rejected',
  request_changes: 'changes_requested',
};

export const decideApprovalSchema = z
  .object({
    environmentId: idSchema.optional(),
    type: z.enum(APPROVAL_TYPES),
    action: z.enum(APPROVAL_ACTIONS),
    comment: z.string().trim().min(1).max(2000).optional(),
  })
  .superRefine((value, context) => {
    if (value.action !== 'approve' && (value.comment ?? '').length < 5) {
      context.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'Explain a rejection or a change request in at least 5 characters',
      });
    }
  });
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

export const revokeApprovalSchema = z.object({
  reason: z.string().trim().min(1).max(2000).optional(),
});
export type RevokeApprovalInput = z.infer<typeof revokeApprovalSchema>;

export interface ApprovalRuleView {
  id: string;
  projectId: string;
  environment: { id: string; name: string } | null;
  type: ApprovalType;
  requiredApprovals: number;
  allowSelfApproval: boolean;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalDecisionView {
  id: string;
  type: ApprovalType;
  environment: { id: string; name: string } | null;
  decision: ApprovalDecision;
  comment: string | null;
  approver: { id: string; fullName: string } | null;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: { id: string; fullName: string } | null;
  revokeReason: string | null;
}

export interface ApprovalRequirementView {
  type: ApprovalType;
  /** Highest count among the applicable rules of this type. */
  requiredApprovals: number;
  approvals: number;
  state: ApprovalState;
  allowSelfApproval: boolean;
}

export interface ReleaseApprovalsView {
  release: {
    id: string;
    name: string;
    version: string;
    status: string;
    createdById: string | null;
  };
  environment: { id: string; name: string; protected: boolean } | null;
  state: ApprovalState;
  requirements: ApprovalRequirementView[];
  /** Full history, newest first, including revoked decisions. */
  history: ApprovalDecisionView[];
  /** What the current user may do right now. */
  actions: {
    decide: boolean;
    /** Approval types the current user would be refused as release creator. */
    selfApprovalBlocked: ApprovalType[];
  };
}

export interface ApprovalRuleInput {
  type: ApprovalType;
  requiredApprovals: number;
  allowSelfApproval: boolean;
}
export interface LiveApprovalDecision {
  type: ApprovalType;
  decision: ApprovalDecision;
}

/**
 * One requirement per approval type that has applicable rules: the highest
 * count wins. A live rejection beats a change request, which beats counting
 * approvals.
 */
export function deriveApprovalRequirements(
  rules: readonly ApprovalRuleInput[],
  decisions: readonly LiveApprovalDecision[],
): ApprovalRequirementView[] {
  return APPROVAL_TYPES.flatMap((type) => {
    const ofType = rules.filter((rule) => rule.type === type);
    if (ofType.length === 0) {
      return [];
    }
    const required = Math.max(...ofType.map((rule) => rule.requiredApprovals));
    const live = decisions.filter((decision) => decision.type === type);
    const approvals = live.filter((decision) => decision.decision === 'approved').length;
    const state: ApprovalState = live.some((decision) => decision.decision === 'rejected')
      ? 'rejected'
      : live.some((decision) => decision.decision === 'changes_requested')
        ? 'changes_requested'
        : approvals >= required
          ? 'approved'
          : 'pending';
    return [
      {
        type,
        requiredApprovals: required,
        approvals,
        state,
        allowSelfApproval: ofType.every((rule) => rule.allowSelfApproval),
      },
    ];
  });
}

/** rejected > changes_requested > pending > approved; no requirement is approved. */
export function combineApprovalStates(states: readonly ApprovalState[]): ApprovalState {
  for (const state of ['rejected', 'changes_requested', 'pending'] as const) {
    if (states.includes(state)) {
      return state;
    }
  }
  return 'approved';
}
