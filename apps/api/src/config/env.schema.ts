import { z } from 'zod';

/**
 * The process refuses to boot with an invalid environment.
 *
 * A missing JWT secret or a malformed database URL is a deployment mistake, and
 * the cheapest moment to detect it is before the first request is served —
 * never in the middle of a login attempt at 3am.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),
    API_PREFIX: z.string().default('api'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /**
     * `json` writes one JSON object per line, which is what a log collector
     * parses; `pretty` is Nest's coloured console output for a human at a
     * terminal. Left unset it follows the environment: json in production.
     */
    LOG_FORMAT: z.enum(['json', 'pretty']).optional(),

    /**
     * How many reverse proxies sit in front of the API. The client address is
     * the one `TRUST_PROXY` hops back along `X-Forwarded-For`; anything further
     * left was written by the client and is not evidence of anything. `0`, the
     * default, ignores the header entirely — the right answer when the API is
     * reachable directly, and the only safe one when nobody knows.
     */
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

    /**
     * How long the process keeps serving after SIGTERM while `/health/ready`
     * already answers 503, so the load balancer stops routing to it before the
     * listener closes.
     */
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(5_000),

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

    /**
     * A separate, stricter budget per client address for the unauthenticated
     * credential endpoints: login, registration and refresh. It is counted
     * apart from the global one, so browsing never eats into it.
     */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),

    /**
     * Prometheus exposition on `GET /metrics`, outside the API prefix. Off by
     * default. With a token, scrapers must send `Authorization: Bearer <token>`;
     * production refuses to enable it without one.
     */
    METRICS_ENABLED: z.enum(['true', 'false']).default('false'),
    METRICS_TOKEN: z.string().min(1).optional(),

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
     * Email delivery. `mock` is the only provider today: it captures messages
     * in memory and never opens a socket. A real provider arrives as a new value
     * here plus one adapter class; no business module reads this.
     */
    EMAIL_PROVIDER: z.enum(['mock']).default('mock'),
    EMAIL_FROM: z.string().email().default('no-reply@qa-flow-hub.local'),

    /**
     * Evidence storage. `local` writes under STORAGE_LOCAL_ROOT (relative paths
     * resolve from the process cwd); an S3-compatible provider arrives as a new
     * value here plus one class, and no business module reads this. The size
     * limit is a development default, not a commercial quota.
     */
    STORAGE_PROVIDER: z.enum(['local', 'memory']).default('local'),
    STORAGE_LOCAL_ROOT: z.string().min(1).default('./var/storage'),
    UPLOAD_MAX_SIZE_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(1024 * 1024 * 1024)
      .default(10 * 1024 * 1024),

    /**
     * Billing (S2-F11). `mock` is the only provider today and is refused at
     * boot in production (see billing-startup.ts): a production instance with
     * a simulated payment provider would hand out paid plans for free.
     * The webhook secret signs and verifies provider callbacks (HMAC-SHA256).
     */
    BILLING_PROVIDER: z.enum(['mock']).default('mock'),
    BILLING_WEBHOOK_SECRET: z
      .string()
      .min(32)
      .default('development-only-billing-webhook-secret-not-for-production'),
    BILLING_TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(14),
    BILLING_PAST_DUE_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
    BILLING_WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
    // Case import (S3-F1). The file is held in memory while it is parsed, so the
    // byte limit is its own and far below UPLOAD_MAX_SIZE_BYTES.
    IMPORT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(5 * 1024 * 1024),
    IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(200_000).default(20_000),
    IMPORT_MAX_CASES: z.coerce.number().int().min(1).max(50_000).default(5_000),
    IMPORT_JOB_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 7)
      .default(24),
    IMPORT_TX_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    IMPORT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    EXPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(100_000),

    // Automated result ingestion (S3-F3). Reports are held in memory while
    // parsed, like imports, so the byte limit is separate and small.
    INGEST_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(5 * 1024 * 1024),
    INGEST_MAX_TESTS: z.coerce.number().int().min(1).max(100_000).default(10_000),
    INGEST_TX_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    INGEST_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
    API_KEYS_MAX_ACTIVE_PER_PROJECT: z.coerce.number().int().min(1).max(1_000).default(25),

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
    LOG_FORMAT: env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'pretty'),
    METRICS_ENABLED: env.METRICS_ENABLED === 'true',
  }))
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') {
      return;
    }

    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    // Anywhere in the list: @fastify/cors treats a list containing "*" as "*".
    if (env.CORS_ORIGINS.split(',').some((origin) => origin.trim() === '*')) {
      fail(
        'CORS_ORIGINS',
        'CORS_ORIGINS cannot contain "*" in production: CORS is configured with credentials',
      );
    }

    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      const problem = weakSecretReason(env[key]);
      if (problem !== null) {
        fail(key, `${key} ${problem}`);
      }
    }

    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      fail(
        'JWT_REFRESH_SECRET',
        'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET: one leaked secret must not mint both token kinds',
      );
    }

    if (env.STORAGE_PROVIDER === 'memory') {
      fail(
        'STORAGE_PROVIDER',
        'STORAGE_PROVIDER=memory loses every attachment on restart and is for tests only',
      );
    }

    if (env.METRICS_ENABLED) {
      const problem =
        env.METRICS_TOKEN === undefined ? 'is required' : weakSecretReason(env.METRICS_TOKEN);
      if (problem !== null) {
        fail('METRICS_TOKEN', `METRICS_TOKEN ${problem} when METRICS_ENABLED=true in production`);
      }
    }
  });

/**
 * Values copied from `.env.example` or a tutorial. Matched case-insensitively
 * anywhere in the secret, because "replace-me-with-a-long-random-value" is
 * long enough to pass a length check and is still public knowledge.
 */
const PLACEHOLDER_MARKERS = [
  'replace-me',
  'replace_me',
  'replace-with',
  'replace_with',
  'change-me',
  'changeme',
  'placeholder',
  'your-secret',
];

/** Fewer distinct characters than this is a pattern, not randomness. */
const MIN_DISTINCT_CHARACTERS = 10;

/**
 * Why a production secret is unacceptable, or `null` when it is fine. Not an
 * entropy estimate — a cheap net for the two mistakes that actually ship: the
 * example value left in place, and `aaaa…` typed to get past the length rule.
 */
export function weakSecretReason(secret: string): string | null {
  if (secret.length < 32) {
    return 'must be at least 32 characters';
  }
  const lower = secret.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))) {
    return 'still holds a placeholder value';
  }
  if (new Set(secret).size < MIN_DISTINCT_CHARACTERS) {
    return 'is not random enough';
  }
  return null;
}

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
