import { z } from 'zod';

/**
 * The process refuses to boot with an invalid environment.
 *
 * A missing JWT secret or a malformed database URL is a deployment mistake, and
 * the cheapest moment to detect it is before the first request is served —
 * never in the middle of a login attempt at 3am.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  API_PREFIX: z.string().default('api'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  /**
   * Access tokens are short lived and verified statelessly; refresh tokens are
   * long lived and checked against the database, so they use a different
   * secret. Leaking one must not compromise the other.
   */
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  /** Comma-separated list of allowed origins, or `*` in development. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),

  /** Brute-force protection on the login endpoint. */
  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

  INVITATION_TTL_DAYS: z.coerce.number().int().min(1).default(7),

  /**
   * Public URL of the web client. Used to build the invitation acceptance link.
   * It is configuration and not a request header on purpose: deriving links
   * from `Host` or `Origin` lets an attacker mint a phishing link that a real
   * email from us would then carry.
   */
  WEB_BASE_URL: z.string().url().default('http://localhost:5173'),

  /**
   * Interactive documentation. Left unset it follows the environment: on in
   * development, off in production, because `/docs` publishes the entire API
   * surface to anonymous callers. Setting it explicitly wins either way, so a
   * private deployment can still turn it on.
   */
  SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),
})
  .transform((env) => ({
    ...env,
    SWAGGER_ENABLED:
      (env.SWAGGER_ENABLED ?? (env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true',
  }))
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.trim() === '*') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS cannot be "*" in production: CORS is configured with credentials',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}
