import { describe, expect, it } from 'vitest';
import {
  combineApprovalStates,
  decideApprovalSchema,
  deriveApprovalRequirements,
} from './release-approval.contracts.js';

const rule = (type: 'qa' | 'product', requiredApprovals = 1, allowSelfApproval = false) => ({
  type,
  requiredApprovals,
  allowSelfApproval,
});

describe('release approvals', () => {
  it('derives one requirement per type with the highest count', () => {
    const result = deriveApprovalRequirements(
      [rule('qa', 1), rule('qa', 2), rule('product')],
      [
        { type: 'qa', decision: 'approved' },
        { type: 'product', decision: 'approved' },
      ],
    );
    expect(
      result.map((entry) => [entry.type, entry.requiredApprovals, entry.approvals, entry.state]),
    ).toEqual([
      ['qa', 2, 1, 'pending'],
      ['product', 1, 1, 'approved'],
    ]);
  });

  it('lets a rejection win over a change request and approvals', () => {
    const state = (decisions: Array<'approved' | 'rejected' | 'changes_requested'>) =>
      deriveApprovalRequirements(
        [rule('qa')],
        decisions.map((decision) => ({ type: 'qa' as const, decision })),
      )[0]!.state;
    expect(state(['approved', 'changes_requested'])).toBe('changes_requested');
    expect(state(['changes_requested', 'rejected', 'approved'])).toBe('rejected');
    expect(state([])).toBe('pending');
  });

  it('combines states and treats no requirement as approved', () => {
    expect(combineApprovalStates([])).toBe('approved');
    expect(combineApprovalStates(['approved', 'pending'])).toBe('pending');
    expect(combineApprovalStates(['pending', 'changes_requested'])).toBe('changes_requested');
    expect(combineApprovalStates(['changes_requested', 'rejected'])).toBe('rejected');
  });

  it('requires a comment to reject or request changes', () => {
    expect(decideApprovalSchema.safeParse({ type: 'qa', action: 'approve' }).success).toBe(true);
    expect(decideApprovalSchema.safeParse({ type: 'qa', action: 'reject' }).success).toBe(false);
    expect(
      decideApprovalSchema.safeParse({ type: 'qa', action: 'request_changes', comment: 'no' })
        .success,
    ).toBe(false);
    expect(
      decideApprovalSchema.safeParse({ type: 'qa', action: 'reject', comment: 'Login broken' })
        .success,
    ).toBe(true);
  });
});
