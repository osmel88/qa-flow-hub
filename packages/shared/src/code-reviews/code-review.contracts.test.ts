import { describe, expect, it } from 'vitest';
import { computeCodeReviewStatus, computeMergeReadiness } from './code-review.contracts.js';

describe('code review status', () => {
  it('lets a change request win, then enough approvals, then any decision', () => {
    expect(computeCodeReviewStatus([], 1, false)).toBe('pending');
    expect(computeCodeReviewStatus(['pending', 'pending'], 1, false)).toBe('pending');
    expect(computeCodeReviewStatus(['approved', 'pending'], 2, false)).toBe('in_review');
    expect(computeCodeReviewStatus(['dismissed'], 1, false)).toBe('in_review');
    expect(computeCodeReviewStatus(['approved', 'approved'], 2, false)).toBe('approved');
    expect(computeCodeReviewStatus(['approved', 'changes_requested'], 1, false)).toBe(
      'changes_requested',
    );
    expect(computeCodeReviewStatus(['approved'], 1, true)).toBe('dismissed');
  });
});

describe('merge readiness', () => {
  const reviewer = (decision: 'approved' | 'pending' | 'changes_requested', canReview = true) => ({
    decision,
    canReview,
  });
  it('needs enough approvals from reviewers who can still review', () => {
    expect(
      computeMergeReadiness({
        dismissed: false,
        reviewers: [reviewer('approved'), reviewer('approved', false)],
        requiredApprovals: 2,
        pullRequestStatus: 'open',
      }),
    ).toEqual({
      ready: false,
      approvals: 1,
      requiredApprovals: 2,
      blockers: ['insufficient_approvals'],
    });
    expect(
      computeMergeReadiness({
        dismissed: false,
        reviewers: [reviewer('approved'), reviewer('approved')],
        requiredApprovals: 2,
        pullRequestStatus: 'approved',
      }).ready,
    ).toBe(true);
  });
  it('lists every blocker', () => {
    expect(
      computeMergeReadiness({
        dismissed: true,
        reviewers: [reviewer('changes_requested')],
        requiredApprovals: 1,
        pullRequestStatus: 'merged',
      }).blockers,
    ).toEqual([
      'dismissed',
      'changes_requested',
      'insufficient_approvals',
      'pull_request_not_open',
    ]);
    expect(
      computeMergeReadiness({
        dismissed: false,
        reviewers: [reviewer('approved')],
        requiredApprovals: 1,
        pullRequestStatus: undefined,
      }).ready,
    ).toBe(true);
  });
});
