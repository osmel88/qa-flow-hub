import { NOTIFICATION_TYPES } from '@qa-flow-hub/shared';
import { describe, expect, it } from 'vitest';
import { renderEmail } from './email-templates';
import { VAR_SHAPES, fromPayload, toPayload } from './template-payload';

const invitation = {
  organizationName: 'Acme',
  inviterName: 'Grace',
  role: 'viewer',
  acceptUrl: 'https://app.local/accept?token=t',
  expiresAt: new Date('2026-10-10T08:00:00.000Z'),
};

describe('stored template payloads', () => {
  it('has a shape for every notification type', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(Object.keys(VAR_SHAPES[type]).length).toBeGreaterThan(0);
    }
  });

  it('round-trips dates and renders the same email as the original', () => {
    const stored = JSON.parse(JSON.stringify(toPayload('organization_invitation', invitation)));
    expect(stored.expiresAt).toBe('2026-10-10T08:00:00.000Z');
    const vars = fromPayload('organization_invitation', stored);
    expect(vars).toEqual(invitation);
    expect(vars === null ? null : renderEmail('organization_invitation', vars)).toEqual(
      renderEmail('organization_invitation', invitation),
    );
  });

  it.each([
    ['null', null],
    ['an array', []],
    [
      'a missing variable',
      { ...toPayload('organization_invitation', invitation), role: undefined },
    ],
    ['an extra variable', { ...toPayload('organization_invitation', invitation), extra: 'x' }],
    ['a mistyped variable', { ...toPayload('organization_invitation', invitation), role: 3 }],
    ['an invalid date', { ...toPayload('organization_invitation', invitation), expiresAt: 'nope' }],
  ])('rejects %s', (_label, payload) => {
    expect(fromPayload('organization_invitation', JSON.parse(JSON.stringify(payload)))).toBeNull();
  });

  it('rejects a payload of another template', () => {
    expect(
      fromPayload('password_changed', toPayload('organization_invitation', invitation)),
    ).toBeNull();
  });

  it('rejects non-finite numbers', () => {
    const payload = {
      assigneeName: 'a',
      assignedByName: 'b',
      organizationName: 'o',
      projectName: 'p',
      runName: 'r',
      assignedCases: Number.NaN,
      runUrl: 'u',
    };
    expect(fromPayload('test_run_assignment', payload)).toBeNull();
  });
});
