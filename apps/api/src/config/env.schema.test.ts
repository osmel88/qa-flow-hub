import { describe, expect, it } from 'vitest';
import { validateEnv, weakSecretReason } from './env.schema';

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  JWT_ACCESS_SECRET: 'Kx7fQ2mZp9LwR4tV8nB1cY6hJ3sD5gAe',
  JWT_REFRESH_SECRET: 'Wq4eT8yU1iO6pA3sD9fG2hJ7kL5zX0cV',
};

const production = {
  ...validEnv,
  NODE_ENV: 'production',
  MFA_ENCRYPTION_KEY: 'Pq3vT8xLm2Rz7Wk4Nd9Fh6Js1Bc5Yg0Ua',
};

describe('validateEnv', () => {
  it('fills defaults so a minimal environment still boots', () => {
    const env = validateEnv({ ...validEnv });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.SWAGGER_ENABLED).toBe(true);
  });

  it('serves the documentation in development and hides it in production', () => {
    expect(validateEnv(production).SWAGGER_ENABLED).toBe(false);
    expect(
      validateEnv({ ...production, SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED,
    ).toBe(true);
  });

  it('refuses a wildcard CORS origin in production because CORS carries credentials', () => {
    expect(() => validateEnv({ ...validEnv, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      /CORS_ORIGINS/,
    );
    expect(validateEnv({ ...validEnv, CORS_ORIGINS: '*' }).CORS_ORIGINS).toBe('*');
  });

  it('refuses a wildcard hidden inside a list of origins in production', () => {
    // @fastify/cors turns any list containing "*" into "allow every origin".
    for (const origins of ['https://app.example.com,*', 'https://app.example.com, * ']) {
      expect(() =>
        validateEnv({ ...validEnv, NODE_ENV: 'production', CORS_ORIGINS: origins }),
      ).toThrow(/CORS_ORIGINS/);
    }
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

  describe('production rules', () => {
    it('accepts a production environment with distinct random secrets', () => {
      const env = validateEnv(production);

      expect(env.LOG_FORMAT).toBe('json');
      expect(env.METRICS_ENABLED).toBe(false);
      expect(env.TRUST_PROXY).toBe(0);
    });

    it('logs for a human outside production unless told otherwise', () => {
      expect(validateEnv(validEnv).LOG_FORMAT).toBe('pretty');
      expect(validateEnv({ ...validEnv, LOG_FORMAT: 'json' }).LOG_FORMAT).toBe('json');
    });

    it('refuses the development MFA key and weak MFA keys in production', () => {
      expect(() =>
        validateEnv({ ...production, MFA_ENCRYPTION_KEY: undefined }),
      ).toThrow(/MFA_ENCRYPTION_KEY/);
      expect(() =>
        validateEnv({ ...production, MFA_ENCRYPTION_KEY: 'a'.repeat(40) }),
      ).toThrow(/MFA_ENCRYPTION_KEY/);
    });

    it('refuses the same secret for access and refresh tokens', () => {
      expect(() =>
        validateEnv({ ...production, JWT_REFRESH_SECRET: validEnv.JWT_ACCESS_SECRET }),
      ).toThrow(/JWT_REFRESH_SECRET must differ/);
    });

    it.each([
      ['the example placeholder', 'replace-me-with-a-long-random-value-0123'],
      ['a replace-with instruction', 'replace-with-a-long-random-string-0123456789'],
      ['a change-me value', 'Change-Me-Before-Deploying-This-Thing-42'],
      ['a repeated character', 'a'.repeat(48)],
    ])('refuses %s as a production secret', (_label, secret) => {
      expect(() => validateEnv({ ...production, JWT_ACCESS_SECRET: secret })).toThrow(
        /JWT_ACCESS_SECRET/,
      );
    });

    it('keeps the weak-secret rules out of development', () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          JWT_ACCESS_SECRET: 'a'.repeat(32),
          JWT_REFRESH_SECRET: 'a'.repeat(32),
        }),
      ).not.toThrow();
    });

    it('refuses in-memory storage in production', () => {
      expect(() => validateEnv({ ...production, STORAGE_PROVIDER: 'memory' })).toThrow(
        /STORAGE_PROVIDER/,
      );
      expect(validateEnv({ ...validEnv, STORAGE_PROVIDER: 'memory' }).STORAGE_PROVIDER).toBe(
        'memory',
      );
    });

    it('refuses production metrics without a strong token', () => {
      expect(() => validateEnv({ ...production, METRICS_ENABLED: 'true' })).toThrow(
        /METRICS_TOKEN is required/,
      );
      expect(() =>
        validateEnv({ ...production, METRICS_ENABLED: 'true', METRICS_TOKEN: 'short' }),
      ).toThrow(/METRICS_TOKEN/);
      const env = validateEnv({
        ...production,
        METRICS_ENABLED: 'true',
        METRICS_TOKEN: 'Pm3nV7bX1zQ9wE5rT2yU8iO4pA6sD0fG',
      });
      expect(env.METRICS_ENABLED).toBe(true);
    });

    it('bounds the trusted proxy hops', () => {
      expect(validateEnv({ ...production, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
      expect(() => validateEnv({ ...production, TRUST_PROXY: '-1' })).toThrow(/TRUST_PROXY/);
    });
  });

  describe('weakSecretReason', () => {
    it('accepts a random value and explains each rejection', () => {
      expect(weakSecretReason(validEnv.JWT_ACCESS_SECRET)).toBeNull();
      expect(weakSecretReason('short')).toMatch(/32 characters/);
      expect(weakSecretReason('xx-PLACEHOLDER-secret-0123456789abcdef')).toMatch(/placeholder/);
      expect(weakSecretReason('abababababababababababababababab')).toMatch(/random/);
    });
  });
});
