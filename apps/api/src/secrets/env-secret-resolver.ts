import { Injectable } from '@nestjs/common';
import { InvalidSecretReferenceError, SecretResolver } from './secret-resolver';

/** Every variable this resolver may read starts with this prefix. */
export const SECRET_ENV_PREFIX = 'QAFLOW_SECRET_';

const REFERENCE = /^env:([A-Z0-9_]{1,200})$/;

/**
 * Resolves `env:<VARIABLE>` references from the process environment.
 *
 * Two rules keep a tenant-controlled reference from reaching anything it
 * should not:
 *
 * - the variable must start with `QAFLOW_SECRET_`, so `env:JWT_ACCESS_SECRET`
 *   or `env:DATABASE_URL` are rejected however the reference got written;
 * - the next segment must be the organization id, upper-cased, so
 *   organization A can never name `QAFLOW_SECRET_<B>_GITHUB_TOKEN`.
 *
 * It is the development and single-tenant provider. Environment variables are
 * fixed at deploy time and visible to the whole process, which is why the
 * multi-tenant production provider is an external secret manager (ADR 0014).
 */
@Injectable()
export class EnvSecretResolver implements SecretResolver {
  readonly scheme = 'env';

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** The variable an organization's secret named `name` lives under. */
  static variableFor(organizationId: string, name: string): string {
    return `${SECRET_ENV_PREFIX}${normalise(organizationId)}_${normalise(name)}`;
  }

  resolve(secretRef: string, scope: { organizationId: string }): Promise<string | null> {
    const match = REFERENCE.exec(secretRef);
    const variable = match?.[1];
    if (variable === undefined) {
      return Promise.reject(new InvalidSecretReferenceError('expected env:<VARIABLE>'));
    }

    const ownPrefix = `${SECRET_ENV_PREFIX}${normalise(scope.organizationId)}_`;
    if (!variable.startsWith(ownPrefix) || variable.length === ownPrefix.length) {
      return Promise.reject(
        new InvalidSecretReferenceError('the variable does not belong to this organization'),
      );
    }

    const value = this.env[variable];
    return Promise.resolve(value === undefined || value === '' ? null : value);
  }
}

function normalise(segment: string): string {
  return segment.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}
