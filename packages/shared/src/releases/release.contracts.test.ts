import { describe, expect, it } from 'vitest';
import {
  RELEASE_STATUSES,
  RELEASE_TRANSITIONS,
  createReleaseSchema,
  isOpenRelease,
  updateReleaseSchema,
} from './release.contracts.js';

describe('release contracts', () => {
  it('accepts a release with optional tag and dates', () => {
    const parsed = createReleaseSchema.parse({
      projectId: 'p1',
      name: ' Spring launch ',
      version: '2.4.0-rc.1+build.7',
      tag: 'v2.4.0',
      startDate: '2026-10-01',
      targetDate: '2026-10-31',
    });
    expect(parsed).toMatchObject({ name: 'Spring launch', version: '2.4.0-rc.1+build.7' });
  });

  it.each(['', '1.0/2', '1.0 beta', '../1.0', '-1.0', 'x'.repeat(65), '1.0;drop'])(
    'rejects the version %j',
    (version) => {
      expect(createReleaseSchema.safeParse({ projectId: 'p1', name: 'R', version }).success).toBe(
        false,
      );
    },
  );

  it('rejects impossible dates and a target before the start', () => {
    const base = { projectId: 'p1', name: 'R', version: '1.0.0' };
    expect(createReleaseSchema.safeParse({ ...base, startDate: '2026-02-30x' }).success).toBe(
      false,
    );
    expect(createReleaseSchema.safeParse({ ...base, startDate: '2026-13-45' }).success).toBe(false);
    expect(createReleaseSchema.safeParse({ ...base, targetDate: '2026-02-30' }).success).toBe(
      false,
    );
    expect(createReleaseSchema.safeParse({ ...base, targetDate: '2028-02-29' }).success).toBe(true);
    expect(
      createReleaseSchema.safeParse({ ...base, startDate: '2026-10-02', targetDate: '2026-10-01' })
        .success,
    ).toBe(false);
    expect(
      createReleaseSchema.safeParse({ ...base, startDate: null, targetDate: null }).success,
    ).toBe(true);
  });

  it('does not let an update change the version and needs at least one field', () => {
    expect(updateReleaseSchema.safeParse({}).success).toBe(false);
    expect(updateReleaseSchema.parse({ name: 'New', version: '9.9.9' })).toEqual({ name: 'New' });
  });

  it('keeps archived terminal and only planned/in progress open', () => {
    expect(RELEASE_TRANSITIONS.archived).toEqual([]);
    expect(RELEASE_TRANSITIONS.planned).not.toContain('released');
    for (const status of RELEASE_STATUSES) {
      expect(RELEASE_TRANSITIONS[status]).not.toContain(status);
    }
    expect(RELEASE_STATUSES.filter(isOpenRelease)).toEqual(['planned', 'in_progress']);
  });
});
