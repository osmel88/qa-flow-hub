import { describe, expect, it } from 'vitest';
import { forgotPasswordSchema, resetPasswordSchema } from './password-reset.contracts.js';

describe('password reset contracts', () => {
  it('normalises the email of a request', () => {
    expect(forgotPasswordSchema.parse({ email: ' Ada@Example.TEST ' }).email).toBe(
      'ada@example.test',
    );
    expect(forgotPasswordSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });

  it('applies the password policy to the new password and bounds the token', () => {
    const token = 'x'.repeat(43);
    expect(resetPasswordSchema.safeParse({ token, newPassword: 'Str0ngPassword!' }).success).toBe(
      true,
    );
    expect(resetPasswordSchema.safeParse({ token, newPassword: 'short' }).success).toBe(false);
    expect(
      resetPasswordSchema.safeParse({ token: 'abc', newPassword: 'Str0ngPassword!' }).success,
    ).toBe(false);
  });
});
