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
