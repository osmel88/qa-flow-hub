import { describe, expect, it } from 'vitest';
import {
  changePasswordSchema,
  emailSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
} from './auth.contracts.js';

describe('emailSchema', () => {
  it('normalises case and surrounding whitespace', () => {
    // The database unique index is case-sensitive, so normalising here is what
    // stops "Ada@x.test" and "ada@x.test" becoming two accounts.
    expect(emailSchema.parse('  Ada@Example.TEST ')).toBe('ada@example.test');
  });

  it.each(['not-an-email', '@example.test', 'ada@', ''])('rejects %j', (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('accepts a long password with mixed characters', () => {
    expect(passwordSchema.safeParse('Str0ngPassword!').success).toBe(true);
  });

  it.each([
    ['too short', 'Sh0rt!'],
    ['no uppercase', 'nouppercase1here'],
    ['no lowercase', 'NOLOWERCASE1HERE'],
    ['no digit', 'NoDigitsInHere!!'],
    ['over the maximum', `A1${'a'.repeat(200)}`],
  ])('rejects a password with %s', (_reason, value) => {
    expect(passwordSchema.safeParse(value).success).toBe(false);
  });
});

describe('registerSchema', () => {
  it('drops unknown fields, which is the mass-assignment defence', () => {
    const parsed = registerSchema.parse({
      email: 'ada@example.test',
      password: 'Str0ngPassword!',
      fullName: 'Ada',
      isActive: false,
      role: 'organization_owner',
    });

    expect(parsed).toEqual({
      email: 'ada@example.test',
      password: 'Str0ngPassword!',
      fullName: 'Ada',
    });
  });
});

describe('loginSchema', () => {
  it('does not apply the password policy', () => {
    // A stored password may predate a policy change, and rejecting it here
    // would lock the user out with a message that also leaks the policy.
    expect(loginSchema.safeParse({ email: 'ada@example.test', password: 'old' }).success).toBe(true);
  });
});

describe('changePasswordSchema', () => {
  it('refuses a new password identical to the current one', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'Str0ngPassword!',
      newPassword: 'Str0ngPassword!',
    });

    expect(result.success).toBe(false);
  });
});
