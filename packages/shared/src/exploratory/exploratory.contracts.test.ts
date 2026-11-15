import { describe, expect, it } from 'vitest';
import {
  canRunExploratoryAction,
  createExploratorySessionSchema,
  sessionDurationSeconds,
  summarizeFindings,
} from './exploratory.contracts.js';

describe('exploratory sessions', () => {
  it('allows only the documented lifecycle moves', () => {
    expect(canRunExploratoryAction('planned', 'start')).toBe(true);
    expect(canRunExploratoryAction('active', 'pause')).toBe(true);
    expect(canRunExploratoryAction('paused', 'resume')).toBe(true);
    expect(canRunExploratoryAction('active', 'resume')).toBe(false);
    expect(canRunExploratoryAction('paused', 'start')).toBe(false);
    expect(canRunExploratoryAction('completed', 'complete')).toBe(false);
    expect(canRunExploratoryAction('completed', 'archive')).toBe(true);
    expect(canRunExploratoryAction('archived', 'archive')).toBe(false);
  });

  it('measures active time without the pauses', () => {
    const start = new Date('2027-01-01T10:00:00Z');
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
    expect(
      sessionDurationSeconds({ startedAt: null, endedAt: null, pausedAt: null, pausedSeconds: 0 }),
    ).toBeNull();
    expect(
      sessionDurationSeconds(
        { startedAt: start, endedAt: at(30), pausedAt: null, pausedSeconds: 600 },
        at(99),
      ),
    ).toBe(1200);
    // A pause still running does not count either.
    expect(
      sessionDurationSeconds(
        { startedAt: start, endedAt: null, pausedAt: at(20), pausedSeconds: 0 },
        at(50),
      ),
    ).toBe(1200);
  });

  it('summarizes findings and distinct related defects', () => {
    const summary = summarizeFindings(
      [
        { kind: 'bug', severity: 'critical', defectId: 'd1', defectCreated: true },
        { kind: 'bug', severity: 'major', defectId: 'd2', defectCreated: false },
        { kind: 'risk', severity: 'minor', defectId: null, defectCreated: false },
      ],
      ['d2', 'd3'],
    );
    expect(summary).toMatchObject({ findings: 3, defectsCreated: 1, defectsLinked: 3 });
    expect(summary.byKind).toMatchObject({ bug: 2, risk: 1, question: 0 });
    expect(summary.bySeverity).toMatchObject({ critical: 1, major: 1, minor: 1, blocker: 0 });
  });

  it('accepts http links only as attachment metadata', () => {
    const base = { projectId: 'p', title: 'Checkout tour', charter: 'Explore payments' };
    expect(
      createExploratorySessionSchema.safeParse({
        ...base,
        links: [{ label: 'Video', url: 'https://example.com/v', kind: 'attachment' }],
      }).success,
    ).toBe(true);
    expect(
      createExploratorySessionSchema.safeParse({
        ...base,
        links: [{ label: 'Bad', url: 'javascript:alert(1)' }],
      }).success,
    ).toBe(false);
  });
});
