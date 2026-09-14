import { z } from 'zod';
import { SYNCABLE_ENTITIES, SyncProvider } from './jira-sync.contracts.js';

/**
 * External traceability (S2-F5): one project, every provider, one table.
 *
 * Internal traceability (`/traceability`) answers "which cases cover this
 * requirement"; this answers "where does each of our entities live in Jira,
 * TestRail or GitHub, and can we still trust that link". The two never share a
 * row: a `TraceabilityLink` is a relation between two of our entities, an
 * `ExternalReference` is a relation between one of ours and one of theirs.
 *
 * The status is *derived* at read time from three sources — the reference, the
 * entity it points at, and the connection it was made through — and never
 * stored, so a real provider later only has to keep writing the same
 * `ExternalReference` rows for the view to keep working.
 */

export const SYNC_PROVIDERS = ['jira', 'testrail', 'github'] as const;
export const syncProviderSchema = z.enum(SYNC_PROVIDERS);

export const syncableEntitySchema = z.enum(SYNCABLE_ENTITIES);

export const EXTERNAL_SYNC_STATUSES = ['synced', 'linked', 'stale', 'missing', 'error'] as const;
export type ExternalSyncStatus = (typeof EXTERNAL_SYNC_STATUSES)[number];
export const externalSyncStatusSchema = z.enum(EXTERNAL_SYNC_STATUSES);

/**
 * Why a row is in the state it is. Statuses are coarse on purpose (five
 * values a filter can hold); issues carry the precise reason so the UI can
 * explain it and a test can assert it.
 */
export const EXTERNAL_TRACEABILITY_ISSUES = [
  /** The entity the reference points at no longer exists (hard delete or wrong id). */
  'orphaned_entity',
  /** The entity was soft-deleted; the provider still has its counterpart. */
  'deleted_entity',
  /** The entity was archived; the provider still has its counterpart. */
  'archived_entity',
  /** The entity changed after the last push to the provider. */
  'entity_changed',
  /** The last verification could not find the external object at the provider. */
  'provider_lost',
  /** More than one reference of the same provider points at this entity. */
  'duplicate_reference',
  /** The same external object is referenced by more than one entity. */
  'shared_external_id',
  /** The reference was made through a connection that no longer exists. */
  'connection_missing',
  /** The provider is configured but disconnected. */
  'connection_disabled',
  /** The provider's connection is in error. */
  'connection_error',
  /** The reference was never stamped with a sync time. */
  'never_synced',
  /** The provider is connected and the entity is active but has no reference yet. */
  'not_linked',
] as const;
export type ExternalTraceabilityIssue = (typeof EXTERNAL_TRACEABILITY_ISSUES)[number];

export type InternalEntityState = 'active' | 'archived' | 'deleted' | 'missing';

/** Provider-side type of the object a reference points at, in neutral words. */
export const EXTERNAL_ENTITY_KINDS = [
  'issue',
  'bug',
  'suite',
  'case',
  'run',
  'result',
  'workflow_run',
  'automated_test',
] as const;
export type ExternalEntityKind = (typeof EXTERNAL_ENTITY_KINDS)[number];

export interface ExternalTraceabilityRow {
  /** Null when the row describes a missing link. */
  referenceId: string | null;
  entityType: (typeof SYNCABLE_ENTITIES)[number];
  entityId: string;
  /** WEB-R-1, WEB-C-3, run name…; null when the entity is gone. */
  entityKey: string | null;
  entityLabel: string | null;
  entityState: InternalEntityState;
  /** Parent entity that anchors the row in the UI, e.g. the run of a result. */
  parentEntityId: string | null;
  provider: SyncProvider;
  externalKind: ExternalEntityKind;
  externalId: string | null;
  externalKey: string | null;
  externalUrl: string | null;
  /** Neutral metadata the provider side recorded (branch, run number…). */
  metadata: Record<string, string>;
  previousExternalId: string | null;
  status: ExternalSyncStatus;
  issues: ExternalTraceabilityIssue[];
  lastSyncAt: string | null;
  lastVerifiedAt: string | null;
  error: string | null;
  /** Whether an existing sync endpoint can repair this row. */
  canResync: boolean;
}

export interface ExternalTraceabilityProviderSummary {
  provider: SyncProvider;
  configured: boolean;
  enabled: boolean;
  connectionStatus: 'pending' | 'disconnected' | 'connected' | 'error' | null;
  lastError: string | null;
  counts: Record<ExternalSyncStatus, number>;
}

export interface ExternalTraceabilityView {
  projectId: string;
  generatedAt: string;
  providers: ExternalTraceabilityProviderSummary[];
  counts: Record<ExternalSyncStatus, number>;
  rows: ExternalTraceabilityRow[];
}

export const externalTraceabilityQuerySchema = z.object({
  projectId: z.string().min(1),
  provider: syncProviderSchema.optional(),
  entityType: syncableEntitySchema.optional(),
  status: externalSyncStatusSchema.optional(),
  /** Missing links are opt-out: they are the noisiest rows and the least actionable in bulk. */
  includeMissing: z.enum(['true', 'false']).default('true'),
});
export type ExternalTraceabilityQuery = z.infer<typeof externalTraceabilityQuerySchema>;

export const verifyExternalTraceabilityBodySchema = z.object({
  projectId: z.string().min(1),
  provider: syncProviderSchema.optional(),
});
export type VerifyExternalTraceabilityBody = z.infer<typeof verifyExternalTraceabilityBodySchema>;

export interface ExternalTraceabilityVerificationView {
  projectId: string;
  verifiedAt: string;
  checked: number;
  present: number;
  lost: number;
  /** Providers whose verification failed, with the error the connection now carries. */
  failed: { provider: SyncProvider; error: string }[];
}
