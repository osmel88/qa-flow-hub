import { describe, expect, it } from 'vitest';
import {
  WORK_ITEM_TYPES,
  canBeParentOf,
  createWorkItemSchema,
  isClosedWorkItemStatus,
  listWorkItemsQuerySchema,
  normalizeLabels,
  updateWorkItemSchema,
} from './work-item.contracts.js';

describe('work item contracts', () => {
  it('applies defaults and normalises labels', () => {
    const parsed = createWorkItemSchema.parse({
      projectId: 'p1',
      title: '  Checkout with saved cards ',
      labels: ['Payments', ' payments', 'UX', 'Café'.normalize('NFD')],
    });
    expect(parsed).toMatchObject({
      title: 'Checkout with saved cards',
      type: 'story',
      status: 'backlog',
      priority: 'medium',
      labels: ['payments', 'ux', 'café'],
    });
  });

  it('bounds title, labels and estimate', () => {
    const base = { projectId: 'p1', title: 'Valid title' };
    expect(createWorkItemSchema.safeParse({ ...base, title: 'ab' }).success).toBe(false);
    expect(createWorkItemSchema.safeParse({ ...base, title: 'x'.repeat(201) }).success).toBe(false);
    expect(
      createWorkItemSchema.safeParse({
        ...base,
        labels: Array.from({ length: 21 }, (_, i) => `l${i}`),
      }).success,
    ).toBe(false);
    expect(createWorkItemSchema.safeParse({ ...base, labels: ['a,b'] }).success).toBe(false);
    expect(createWorkItemSchema.safeParse({ ...base, labels: ['-start'] }).success).toBe(false);
    for (const estimate of [-1, 1000.5, 1.234, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(createWorkItemSchema.safeParse({ ...base, estimate }).success, String(estimate)).toBe(
        false,
      );
    }
    for (const estimate of [0, 0.5, 13, 2.25, 1000]) {
      expect(createWorkItemSchema.safeParse({ ...base, estimate }).success, String(estimate)).toBe(
        true,
      );
    }
  });

  it('rejects unknown types and statuses', () => {
    const base = { projectId: 'p1', title: 'Valid title' };
    expect(createWorkItemSchema.safeParse({ ...base, type: 'saga' }).success).toBe(false);
    expect(createWorkItemSchema.safeParse({ ...base, status: 'closed' }).success).toBe(false);
  });

  it('needs a real change to update; version alone is not one', () => {
    expect(updateWorkItemSchema.safeParse({}).success).toBe(false);
    expect(updateWorkItemSchema.safeParse({ version: 3 }).success).toBe(false);
    expect(updateWorkItemSchema.safeParse({ status: 'done', version: 3 }).success).toBe(true);
    expect(updateWorkItemSchema.safeParse({ parentId: null }).success).toBe(true);
    expect(updateWorkItemSchema.safeParse({ status: 'done', version: 0 }).success).toBe(false);
  });

  it('ranks the hierarchy so that cycles are impossible', () => {
    expect(canBeParentOf('epic', 'feature')).toBe(true);
    expect(canBeParentOf('epic', 'story')).toBe(true);
    expect(canBeParentOf('feature', 'bug')).toBe(true);
    expect(canBeParentOf('story', 'task')).toBe(true);
    expect(canBeParentOf('story', 'bug')).toBe(false);
    expect(canBeParentOf('task', 'story')).toBe(false);
    expect(canBeParentOf('feature', 'epic')).toBe(false);
    for (const type of WORK_ITEM_TYPES) {
      expect(canBeParentOf(type, type)).toBe(false);
    }
  });

  it('treats done and cancelled as closed', () => {
    expect(isClosedWorkItemStatus('done')).toBe(true);
    expect(isClosedWorkItemStatus('cancelled')).toBe(true);
    expect(isClosedWorkItemStatus('blocked')).toBe(false);
  });

  it('accepts `none` reference filters and normalises the label filter', () => {
    const parsed = listWorkItemsQuerySchema.parse({
      projectId: 'p1',
      assigneeId: 'none',
      releaseId: 'rel_1',
      label: ' Payments ',
    });
    expect(parsed).toMatchObject({ assigneeId: 'none', releaseId: 'rel_1', label: 'payments' });
    expect(normalizeLabels(['A', 'a'])).toEqual(['a']);
  });
});

describe('hierarchy rollups', () => {
  it('aggregates statuses, estimates and progress without cancelled items', async () => {
    const { computeRollup } = await import('./work-item.contracts.js');
    const rollup = computeRollup([
      { status: 'done', estimate: 3 },
      { status: 'done', estimate: null },
      { status: 'in_progress', estimate: 2.5 },
      { status: 'cancelled', estimate: 8 },
    ]);
    expect(rollup).toMatchObject({ count: 4, estimate: 13.5, unestimated: 1, progress: 66.7 });
    expect(rollup.byStatus).toMatchObject({ done: 2, in_progress: 1, cancelled: 1, backlog: 0 });
    expect(computeRollup([]).progress).toBeNull();
    expect(computeRollup([{ status: 'cancelled', estimate: null }]).progress).toBeNull();
  });

  it('accepts top level or a parent when reparenting', async () => {
    const { reparentWorkItemSchema } = await import('./work-item.contracts.js');
    expect(reparentWorkItemSchema.safeParse({ parentId: null }).success).toBe(true);
    expect(reparentWorkItemSchema.safeParse({ parentId: 'wi_1', version: 2 }).success).toBe(true);
    expect(reparentWorkItemSchema.safeParse({}).success).toBe(false);
  });
});
