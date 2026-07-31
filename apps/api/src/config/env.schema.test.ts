import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

describe('validateEnv', () => {
  it('fills defaults so a minimal environment still boots', () => {
    const env = validateEnv({ ...validEnv });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.SWAGGER_ENABLED).toBe(true);
  });

  it('rejects a short access secret', () => {
    expect(() => validateEnv({ ...validEnv, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('rejects a malformed database url', () => {
    expect(() => validateEnv({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('coerces numeric variables that arrive as strings', () => {
    expect(validateEnv({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });
});
