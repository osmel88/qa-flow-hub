import { z } from 'zod';
import { redactSecrets } from './build.contracts.js';
import type { DeploymentStatus } from './deployment.contracts.js';

/**
 * Environments (S6-F1): where deployments of a project land. Formalizes the
 * minimal table of S5-F5. Archived environments keep their deployment
 * history and stop accepting deployments; protected ones (production by
 * default) need {@link PROTECTED_ENVIRONMENT_PERMISSION} to deploy to or roll
 * back. Health is derived from the deployments, never stored.
 */
export const ENVIRONMENT_KINDS = ['development', 'qa', 'staging', 'production', 'custom'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export const ENVIRONMENT_STATUSES = ['active', 'inactive', 'archived'] as const;
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

export const ENVIRONMENT_HEALTHS = [
  'healthy',
  'deploying',
  'failing',
  'idle',
  'inactive',
  'archived',
] as const;
export type EnvironmentHealth = (typeof ENVIRONMENT_HEALTHS)[number];

/** Deploying to, moving or rolling back in a protected environment needs this. */
export const PROTECTED_ENVIRONMENT_PERMISSION = 'work_items.manage' as const;

const idSchema = z.string().min(1).max(64);
const SENSITIVE_KEY = /pass|secret|token|credential|auth|private|cookie|session|api[-_ ]?key/i;

export const environmentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'Letters, digits, spaces, dots, dashes and underscores');

const urlSchema = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'Only http and https URLs');

/** Small non-sensitive facts (region, cluster…): secret-looking keys or values are refused. */
export const environmentMetadataSchema = z
  .record(
    z.string().trim().min(1).max(60),
    z.union([z.string().max(500), z.number().finite(), z.boolean()]),
  )
  .refine((value) => Object.keys(value).length <= 30, 'At most 30 metadata entries')
  .refine(
    (value) =>
      Object.entries(value).every(
        ([key, entry]) =>
          !SENSITIVE_KEY.test(key) && (typeof entry !== 'string' || redactSecrets(entry) === entry),
      ),
    'Environment metadata must not hold secrets',
  );
export type EnvironmentMetadata = z.infer<typeof environmentMetadataSchema>;

const positionSchema = z.number().int().min(0).max(999);

/**
 * Whether a rollback in a protected environment must pass the quality gates
 * and approvals of the release it goes back to (S6-F5). An emergency
 * rollback skips them either way.
 */
export const ROLLBACK_CHECK_POLICIES = ['enforce', 'skip'] as const;
export type RollbackCheckPolicy = (typeof ROLLBACK_CHECK_POLICIES)[number];

export const createEnvironmentSchema = z.object({
  projectId: idSchema,
  name: environmentNameSchema,
  kind: z.enum(ENVIRONMENT_KINDS).default('custom'),
  description: z.string().trim().min(1).max(2000).optional(),
  /** Defaults to `true` for production, `false` otherwise. */
  protected: z.boolean().optional(),
  position: positionSchema.optional(),
  rollbackChecks: z.enum(ROLLBACK_CHECK_POLICIES).optional(),
  url: urlSchema.optional(),
  metadata: environmentMetadataSchema.optional(),
});
export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>;

export const updateEnvironmentSchema = z
  .object({
    name: environmentNameSchema.optional(),
    kind: z.enum(ENVIRONMENT_KINDS).optional(),
    description: z.string().trim().min(1).max(2000).nullable().optional(),
    protected: z.boolean().optional(),
    position: positionSchema.optional(),
    rollbackChecks: z.enum(ROLLBACK_CHECK_POLICIES).optional(),
    url: urlSchema.nullable().optional(),
    metadata: environmentMetadataSchema.nullable().optional(),
    /** Archiving has its own route. */
    status: z.enum(['active', 'inactive']).optional(),
    version: z.number().int().min(1).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'Nothing to update');
export type UpdateEnvironmentInput = z.infer<typeof updateEnvironmentSchema>;

export const environmentVersionSchema = z.object({
  version: z.number().int().min(1).optional(),
});
export type EnvironmentVersionInput = z.infer<typeof environmentVersionSchema>;

export const listEnvironmentsQuerySchema = z.object({
  projectId: idSchema,
  status: z.enum(ENVIRONMENT_STATUSES).optional(),
  kind: z.enum(ENVIRONMENT_KINDS).optional(),
  protected: z.enum(['true', 'false']).optional(),
  health: z.enum(ENVIRONMENT_HEALTHS).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  /** Archived environments are hidden unless asked for (or `status=archived`). */
  includeArchived: z.enum(['true', 'false']).default('false'),
});
export type ListEnvironmentsQuery = z.infer<typeof listEnvironmentsQuerySchema>;

export interface EnvironmentView {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  kind: EnvironmentKind;
  status: EnvironmentStatus;
  protected: boolean;
  position: number;
  rollbackChecks: RollbackCheckPolicy;
  url: string | null;
  metadata: EnvironmentMetadata | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  health: EnvironmentHealth;
  deploymentCount: number;
  /** The newest live succeeded deployment: what runs there now. */
  current: {
    deploymentId: string;
    identifier: string | null;
    buildId: string | null;
    buildIdentifier: string | null;
    commitSha: string | null;
    release: { id: string; name: string; version: string } | null;
    deployedAt: string | null;
  } | null;
  /** The newest deployment that was not cancelled, whatever its outcome. */
  lastDeployment: {
    id: string;
    identifier: string | null;
    status: DeploymentStatus;
    at: string;
  } | null;
}

/**
 * Derived health: archived/inactive first; then the newest non-cancelled
 * deployment decides (in flight → deploying, failed → failing); otherwise
 * healthy when something runs there and idle when nothing does.
 */
export function computeEnvironmentHealth(
  status: EnvironmentStatus,
  last: DeploymentStatus | null,
  hasCurrent: boolean,
): EnvironmentHealth {
  if (status === 'archived' || status === 'inactive') {
    return status;
  }
  if (last === 'pending' || last === 'deploying') {
    return 'deploying';
  }
  if (last === 'failed') {
    return 'failing';
  }
  return hasCurrent ? 'healthy' : 'idle';
}

/** Production environments start protected unless told otherwise. */
export function defaultProtected(kind: EnvironmentKind, requested: boolean | undefined): boolean {
  return requested ?? kind === 'production';
}
