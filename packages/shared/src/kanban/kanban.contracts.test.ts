import { describe, expect, it } from 'vitest';
import {
  KANBAN_COLUMN_IDS,
  WIP_LIMITED_COLUMNS,
  computeFlowMetrics,
  daysBetween,
  kanbanQuerySchema,
  moveKanbanCardSchema,
  updateWipLimitsSchema,
  wipState,
} from './kanban.contracts.js';

const now = new Date('2027-01-31T12:00:00.000Z');
const ago = (days: number): string => new Date(+now - days * 86_400_000).toISOString();

describe('kanban contracts', () => {
  it('has one column per status but cancelled, and WIP limits on all but done', () => {
    expect(KANBAN_COLUMN_IDS).toEqual([
      'backlog',
      'ready',
      'in_progress',
      'blocked',
      'in_review',
      'done',
    ]);
    expect(WIP_LIMITED_COLUMNS).not.toContain('done');
    expect(
      updateWipLimitsSchema.safeParse({ projectId: 'p', limits: [{ column: 'done', wipLimit: 3 }] })
        .success,
    ).toBe(false);
    expect(
      updateWipLimitsSchema.safeParse({
        projectId: 'p',
        limits: [{ column: 'in_progress', wipLimit: 0 }],
      }).success,
    ).toBe(false);
    expect(
      updateWipLimitsSchema.safeParse({
        projectId: 'p',
        limits: [
          { column: 'in_progress', wipLimit: 2 },
          { column: 'in_progress', wipLimit: null },
        ],
      }).success,
    ).toBe(false);
    expect(
      updateWipLimitsSchema.parse({
        projectId: 'p',
        limits: [{ column: 'blocked', wipLimit: null }],
      }).limits,
    ).toEqual([{ column: 'blocked', wipLimit: null }]);
  });

  it('validates moves and queries', () => {
    expect(
      moveKanbanCardSchema.safeParse({ projectId: 'p', workItemId: 'w', column: 'cancelled' })
        .success,
    ).toBe(false);
    expect(
      moveKanbanCardSchema.safeParse({
        projectId: 'p',
        workItemId: 'w',
        column: 'ready',
        beforeId: 'a',
        afterId: 'b',
      }).success,
    ).toBe(false);
    expect(kanbanQuerySchema.parse({ projectId: 'p' })).toMatchObject({
      swimlane: 'none',
      windowDays: 14,
    });
    expect(kanbanQuerySchema.safeParse({ projectId: 'p', windowDays: '3' }).success).toBe(false);
  });

  it('computes throughput, cycle time and aging over the window', () => {
    const metrics = computeFlowMetrics(
      [
        { id: '1', key: 'W-1', title: 'a', status: 'done', startedAt: ago(5), completedAt: ago(1) },
        { id: '2', key: 'W-2', title: 'b', status: 'done', startedAt: ago(3), completedAt: ago(1) },
        { id: '3', key: 'W-3', title: 'c', status: 'done', startedAt: null, completedAt: ago(9) },
        {
          id: '4',
          key: 'W-4',
          title: 'd',
          status: 'done',
          startedAt: ago(40),
          completedAt: ago(30),
        },
        {
          id: '5',
          key: 'W-5',
          title: 'e',
          status: 'in_progress',
          startedAt: ago(6),
          completedAt: null,
        },
        {
          id: '6',
          key: 'W-6',
          title: 'f',
          status: 'blocked',
          startedAt: ago(2),
          completedAt: null,
        },
        { id: '7', key: 'W-7', title: 'g', status: 'ready', startedAt: null, completedAt: null },
      ],
      now,
      14,
    );
    expect(metrics.throughput.total).toBe(3);
    expect(metrics.throughput.weeks.map((week) => week.count)).toEqual([1, 2]);
    expect(metrics.cycleTime).toEqual({ count: 2, averageDays: 3, medianDays: 2, p85Days: 4 });
    expect(metrics.aging.count).toBe(2);
    expect(metrics.aging.averageDays).toBe(4);
    expect(metrics.aging.oldest.map((entry) => [entry.key, entry.ageDays])).toEqual([
      ['W-5', 6],
      ['W-6', 2],
    ]);
  });

  it('reports empty metrics without dividing by zero', () => {
    const metrics = computeFlowMetrics([], now, 7);
    expect(metrics.throughput).toMatchObject({ total: 0 });
    expect(metrics.throughput.weeks).toHaveLength(1);
    expect(metrics.cycleTime.averageDays).toBeNull();
    expect(metrics.aging.averageDays).toBeNull();
    expect(daysBetween(ago(1), ago(2))).toBe(0);
  });

  it('tells whether a column can take one more card', () => {
    expect(wipState(5, null)).toBe('open');
    expect(wipState(1, 2)).toBe('open');
    expect(wipState(2, 2)).toBe('full');
    expect(wipState(3, 2)).toBe('over');
  });
});
