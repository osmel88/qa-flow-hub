import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * A typed façade over ConfigService.
 *
 * Injecting ConfigService everywhere spreads stringly-typed `get('PORT')` calls
 * across the codebase; this class keeps the environment surface in one place
 * and gives every consumer real types.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get isTest(): boolean {
    return this.nodeEnv === 'test';
  }

  get port(): number {
    return this.get('PORT');
  }

  get host(): string {
    return this.get('HOST');
  }

  get apiPrefix(): string {
    return this.get('API_PREFIX');
  }

  get logLevel(): Env['LOG_LEVEL'] {
    return this.get('LOG_LEVEL');
  }

  get logFormat(): Env['LOG_FORMAT'] {
    return this.get('LOG_FORMAT');
  }

  get trustProxyHops(): number {
    return this.get('TRUST_PROXY');
  }

  get shutdownGraceMs(): number {
    return this.get('SHUTDOWN_GRACE_MS');
  }

  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }

  get jwt(): {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
  } {
    return {
      accessSecret: this.get('JWT_ACCESS_SECRET'),
      refreshSecret: this.get('JWT_REFRESH_SECRET'),
      accessTtl: this.get('JWT_ACCESS_TTL'),
      refreshTtl: this.get('JWT_REFRESH_TTL'),
    };
  }

  get corsOrigins(): string[] | true {
    const raw = this.get('CORS_ORIGINS').trim();
    if (raw === '*') {
      return true;
    }
    return raw
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  get rateLimit(): { max: number; windowMs: number } {
    return { max: this.get('RATE_LIMIT_MAX'), windowMs: this.get('RATE_LIMIT_WINDOW_MS') };
  }

  get authRateLimit(): { max: number; windowMs: number } {
    return {
      max: this.get('AUTH_RATE_LIMIT_MAX'),
      windowMs: this.get('AUTH_RATE_LIMIT_WINDOW_MS'),
    };
  }

  get metrics(): { enabled: boolean; token: string | null } {
    return { enabled: this.get('METRICS_ENABLED'), token: this.get('METRICS_TOKEN') ?? null };
  }

  get authLockout(): { maxFailedAttempts: number; lockoutMinutes: number } {
    return {
      maxFailedAttempts: this.get('AUTH_MAX_FAILED_ATTEMPTS'),
      lockoutMinutes: this.get('AUTH_LOCKOUT_MINUTES'),
    };
  }

  get invitationTtlDays(): number {
    return this.get('INVITATION_TTL_DAYS');
  }

  get webBaseUrl(): string {
    return this.get('WEB_BASE_URL').replace(/\/+$/, '');
  }

  get email(): { provider: Env['EMAIL_PROVIDER']; from: string } {
    return { provider: this.get('EMAIL_PROVIDER'), from: this.get('EMAIL_FROM') };
  }

  get storage(): { provider: Env['STORAGE_PROVIDER']; localRoot: string; maxSizeBytes: number } {
    return {
      provider: this.get('STORAGE_PROVIDER'),
      localRoot: this.get('STORAGE_LOCAL_ROOT'),
      maxSizeBytes: this.get('UPLOAD_MAX_SIZE_BYTES'),
    };
  }

  get swaggerEnabled(): boolean {
    return this.get('SWAGGER_ENABLED');
  }
}
