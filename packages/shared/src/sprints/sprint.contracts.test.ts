import { describe, expect, it } from 'vitest';
import {
  SPRINT_TRANSITIONS,
  closeSprintSchema,
  computeSprintMetrics,
  computeVelocity,
  createSprintSchema,
  isOpenSprint,
  sprintItemsSchema,
  updateSprintSchema,
} from './sprint.contracts.js';

describe('sprint contracts', () => {
  it('only lets planned and active sprints move, and never back', () => {
    expect(SPRINT_TRANSITIONS.planned).toEqual(['active', 'cancelled']);
    expect(SPRINT_TRANSITIONS.active).toEqual(['completed', 'cancelled']);
    expect(SPRINT_TRANSITIONS.completed).toEqual([]);
    expect(SPRINT_TRANSITIONS.cancelled).toEqual([]);
    expect(isOpenSprint('active')).toBe(true);
    expect(isOpenSprint('completed')).toBe(false);
  });

  it('validates dates, capacity and names', () => {
    expect(createSprintSchema.safeParse({ projectId: 'p', name: 'Sprint 1' }).success).toBe(true);
    expect(
      createSprintSchema.safeParse({
        projectId: 'p',
        name: 'S',
        startDate: '2027-01-10',
        endDate: '2027-01-09',
      }).success,
    ).toBe(false);
    expect(
      createSprintSchema.safeParse({ projectId: 'p', name: 'S', startDate: '2027-02-30' }).success,
    ).toBe(false);
    expect(createSprintSchema.safeParse({ projectId: 'p', name: 'S', capacity: -1 }).success).toBe(
      false,
    );
    expect(createSprintSchema.safeParse({ projectId: 'p', name: '  ' }).success).toBe(false);
    expect(updateSprintSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it('defaults carry-over to the backlog and refuses duplicate ids', () => {
    expect(closeSprintSchema.parse({})).toEqual({ carryOverTo: 'backlog' });
    expect(sprintItemsSchema.safeParse({ workItemIds: ['a', 'a'] }).success).toBe(false);
    expect(sprintItemsSchema.safeParse({ workItemIds: [] }).success).toBe(false);
  });

  it('computes capacity load, completed estimate and progress', () => {
    const metrics = computeSprintMetrics(
      [
        { status: 'done', estimate: 5 },
        { status: 'in_progress', estimate: 3 },
        { status: 'cancelled', estimate: 2 },
        { status: 'backlog', estimate: null },
      ],
      8,
      null,
    );
    expect(metrics).toMatchObject({
      count: 4,
      scopeEstimate: 10,
      committedEstimate: 10,
      completedEstimate: 5,
      unestimated: 1,
      load: 125,
      progress: 33.3,
    });
    expect(metrics.byStatus.done).toBe(1);
    expect(computeSprintMetrics([], 0, 4)).toMatchObject({
      load: null,
      progress: null,
      committedEstimate: 4,
    });
  });

  it('averages velocity over completed sprints', () => {
    expect(computeVelocity([])).toBeNull();
    expect(computeVelocity([5, 8, 10])).toBe(7.67);
  });
});
