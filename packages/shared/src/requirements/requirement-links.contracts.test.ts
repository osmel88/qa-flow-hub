import { describe, expect, it } from 'vitest';
import { computeImplementation, linkWorkItemSchema } from './requirement-links.contracts.js';
import { listRequirementsQuerySchema } from './requirement.contracts.js';

describe('computeImplementation', () => {
  it('is not implemented without links or without anything done', () => {
    expect(computeImplementation([])).toMatchObject({ state: 'not_implemented', progress: null });
    expect(computeImplementation(['in_progress', 'backlog'])).toMatchObject({
      state: 'not_implemented',
      progress: 0,
    });
  });

  it('is partially implemented while some items are still open', () => {
    expect(computeImplementation(['done', 'in_review', 'backlog'])).toMatchObject({
      state: 'partially_implemented',
      workItems: 3,
      done: 1,
      progress: 33.3,
    });
  });

  it('ignores cancelled items for completion', () => {
    expect(computeImplementation(['done', 'cancelled'])).toMatchObject({
      state: 'implemented',
      cancelled: 1,
      progress: 100,
    });
    expect(computeImplementation(['cancelled'])).toMatchObject({
      state: 'not_implemented',
      progress: null,
    });
  });
});

describe('link contracts', () => {
  it('defaults the link type to implements and rejects unknown ones', () => {
    expect(linkWorkItemSchema.parse({ workItemId: 'wi_1' }).linkType).toBe('implements');
    expect(linkWorkItemSchema.safeParse({ workItemId: 'wi_1', linkType: 'blocks' }).success).toBe(
      false,
    );
  });

  it('filters requirements by implementation state', () => {
    expect(
      listRequirementsQuerySchema.parse({ projectId: 'p', implementation: 'implemented' })
        .implementation,
    ).toBe('implemented');
    expect(
      listRequirementsQuerySchema.safeParse({ projectId: 'p', implementation: 'maybe' }).success,
    ).toBe(false);
  });
});
