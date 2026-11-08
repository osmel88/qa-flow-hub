import { describe, expect, it } from 'vitest';
import { rollbackEnvironmentSchema, rollbackLabel } from './deployment.contracts.js';
import { updateEnvironmentSchema } from './environment.contracts.js';

describe('environment rollback', () => {
  it('needs a target and a reason of at least 10 characters', () => {
    expect(rollbackEnvironmentSchema.safeParse({ targetDeploymentId: 'd1' }).success).toBe(false);
    expect(
      rollbackEnvironmentSchema.safeParse({ targetDeploymentId: 'd1', reason: 'too short' })
        .success,
    ).toBe(false);
    const parsed = rollbackEnvironmentSchema.parse({
      targetDeploymentId: 'd1',
      reason: 'Checkout is broken',
    });
    expect(parsed.emergency).toBe(false);
  });

  it('says where a rollback came from and went back to', () => {
    expect(rollbackLabel({ identifier: 'd2' }, { identifier: 'd1' })).toBe(
      'Rolled back from d2 to d1',
    );
    expect(rollbackLabel({ identifier: 'd2' }, null)).toBe(
      'Rolled back from d2 to an earlier build',
    );
  });

  it('accepts only known rollback check policies', () => {
    expect(updateEnvironmentSchema.safeParse({ rollbackChecks: 'skip' }).success).toBe(true);
    expect(updateEnvironmentSchema.safeParse({ rollbackChecks: 'never' }).success).toBe(false);
  });
});
