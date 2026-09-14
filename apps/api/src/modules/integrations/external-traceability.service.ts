import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  ExternalReference,
  IntegrationConnection,
  IntegrationStatus,
  Prisma,
} from '@prisma/client';
import {
  EXTERNAL_SYNC_STATUSES,
  ExternalEntityKind,
  ExternalSyncStatus,
  ExternalTraceabilityIssue,
  ExternalTraceabilityProviderSummary,
  ExternalTraceabilityQuery,
  ExternalTraceabilityRow,
  ExternalTraceabilityVerificationView,
  ExternalTraceabilityView,
  SYNC_PROVIDERS,
  SyncProvider,
  SyncableEntity,
  VerifyExternalTraceabilityBody,
} from '@qa-flow-hub/shared';
import {
  AUTOMATION_PROVIDER_ADAPTER,
  AdapterContext,
  AutomatedResult,
  AutomationProviderAdapter,
  ISSUE_TRACKER_ADAPTER,
  IssueTrackerAdapter,
  TEST_MANAGEMENT_ADAPTER,
  TestManagementAdapter,
} from '../../integrations';
import { IntegrationProviderError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { ExternalReferencesRepository } from './external-references.repository';
import { EntitySnapshot, ExternalTraceabilityRepository } from './external-traceability.repository';
import { IntegrationSettingsRepository } from './integration-settings.repository';

/**
 * The relations a provider is expected to hold, and what it calls the other
 * side. Adding a provider or an entity is one line here; the derivation below
 * never names a provider.
 */
const RELATIONS: Record<SyncProvider, Partial<Record<SyncableEntity, ExternalEntityKind>>> = {
  jira: { requirement: 'issue', defect: 'bug' },
  testrail: { test_suite: 'suite', test_case: 'case', test_run: 'run', test_result: 'result' },
  github: { test_run: 'workflow_run', test_result: 'automated_test' },
};

/**
 * Relations for which "no reference" is worth a row. Results are left out:
 * they are append-only and numerous, and not pushing one is the norm rather
 * than an omission.
 */
const EXPECTED: Record<SyncProvider, readonly SyncableEntity[]> = {
  jira: ['requirement', 'defect'],
  testrail: ['test_suite', 'test_case', 'test_run'],
  github: ['test_run'],
};

/** Imported automated results are re-imported per run, not per result. */
const NOT_RESYNCABLE: ReadonlySet<`${SyncProvider}:${SyncableEntity}`> = new Set([
  'github:test_result',
]);

const SEVERITY: Record<ExternalSyncStatus, number> = {
  synced: 0,
  linked: 1,
  missing: 2,
  stale: 3,
  error: 4,
};

const ORDER: Record<SyncableEntity, number> = {
  requirement: 0,
  defect: 1,
  test_suite: 2,
  test_case: 3,
  test_run: 4,
  test_result: 5,
};

/**
 * Derives the state of every external link of a project, without storing it.
 *
 * Three inputs, one pass: the references (what we claimed), the entities (what
 * we still have), the connections (whether the provider is reachable). The
 * output is a flat table with a coarse status for filtering and a precise list
 * of issues for explaining. Nothing is written except by `verify()`, which asks
 * each provider whether the external objects still exist and stamps the answer
 * on the reference's metadata — the only way a `provider_lost` can be known
 * without a network call at read time.
 */
@Injectable()
export class ExternalTraceabilityService {
  constructor(
    @Inject(ISSUE_TRACKER_ADAPTER) private readonly tracker: IssueTrackerAdapter,
    @Inject(TEST_MANAGEMENT_ADAPTER) private readonly testManagement: TestManagementAdapter,
    @Inject(AUTOMATION_PROVIDER_ADAPTER) private readonly automation: AutomationProviderAdapter,
    private readonly references: ExternalReferencesRepository,
    private readonly entities: ExternalTraceabilityRepository,
    private readonly connections: IntegrationSettingsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ExternalTraceabilityQuery): Promise<ExternalTraceabilityView> {
    await this.requireProject(query.projectId);
    const [references, snapshots, connections] = await Promise.all([
      this.references.listForProject({
        projectId: query.projectId,
        ...(query.provider === undefined ? {} : { provider: query.provider }),
        ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      }),
      this.entities.snapshotProject(query.projectId),
      this.connections.list(),
    ]);
    const connectionByProvider = new Map(
      connections.map((connection) => [connection.provider, connection] as const),
    );
    const supported = references.filter(isSupported);

    const perEntity = countBy(supported, (r) => `${r.provider}:${r.entityType}:${r.entityId}`);
    const perExternal = countBy(supported, (r) => `${r.provider}:${r.entityType}:${r.externalId}`);

    const rows: ExternalTraceabilityRow[] = supported.map((reference) => {
      const provider = reference.provider as SyncProvider;
      const entityType = reference.entityType as SyncableEntity;
      return deriveRow(reference, provider, entityType, {
        snapshot: snapshots[entityType].get(reference.entityId),
        connection: connectionByProvider.get(provider),
        duplicate: (perEntity.get(`${provider}:${entityType}:${reference.entityId}`) ?? 0) > 1,
        shared: (perExternal.get(`${provider}:${entityType}:${reference.externalId}`) ?? 0) > 1,
      });
    });

    if (query.includeMissing === 'true') {
      const linked = new Set(supported.map((r) => `${r.provider}:${r.entityType}:${r.entityId}`));
      for (const provider of SYNC_PROVIDERS) {
        if (query.provider !== undefined && query.provider !== provider) continue;
        const connection = connectionByProvider.get(provider);
        if (connection === undefined || !connection.enabled) continue;
        for (const entityType of EXPECTED[provider]) {
          if (query.entityType !== undefined && query.entityType !== entityType) continue;
          for (const snapshot of snapshots[entityType].values()) {
            if (snapshot.state !== 'active') continue;
            if (linked.has(`${provider}:${entityType}:${snapshot.id}`)) continue;
            rows.push(missingRow(provider, entityType, snapshot));
          }
        }
      }
    }

    const visible = (
      query.status === undefined ? rows : rows.filter((row) => row.status === query.status)
    ).sort(byEntity);

    return {
      projectId: query.projectId,
      generatedAt: new Date().toISOString(),
      providers: SYNC_PROVIDERS.map((provider) =>
        summarise(provider, connectionByProvider.get(provider), visible),
      ),
      counts: countStatuses(visible),
      rows: visible,
    };
  }

  /**
   * Asks each provider whether every external object of the project still
   * exists. Provider failures are isolated per provider — a Jira outage must not
   * hide the TestRail answer — and painted on the connection like every other
   * provider error in this module.
   */
  async verify(
    body: VerifyExternalTraceabilityBody,
  ): Promise<ExternalTraceabilityVerificationView> {
    await this.requireProject(body.projectId);
    const [references, connections] = await Promise.all([
      this.references.listForProject({
        projectId: body.projectId,
        ...(body.provider === undefined ? {} : { provider: body.provider }),
      }),
      this.connections.list(),
    ]);
    const verifiedAt = new Date();
    const view: ExternalTraceabilityVerificationView = {
      projectId: body.projectId,
      verifiedAt: verifiedAt.toISOString(),
      checked: 0,
      present: 0,
      lost: 0,
      failed: [],
    };

    for (const provider of SYNC_PROVIDERS) {
      const connection = connections.find((entry) => entry.provider === provider);
      const mine = references.filter(
        (reference) => reference.provider === provider && isSupported(reference),
      );
      if (mine.length === 0 || connection === undefined || !connection.enabled) continue;
      if (connection.mode !== 'mock') continue;
      const context = toContext(connection);
      const probe = this.probeFor(provider, context);
      try {
        for (const reference of mine) {
          const present = await probe(reference);
          view.checked += 1;
          if (present) view.present += 1;
          else view.lost += 1;
          await this.references.updateMetadata(reference.id, {
            ...toStringRecord(reference.metadata),
            verifiedAt: verifiedAt.toISOString(),
            providerState: present ? 'present' : 'missing',
          });
        }
        await this.connections.update(provider, {
          lastError: null,
          status: IntegrationStatus.connected,
        });
      } catch (error) {
        if (!(error instanceof IntegrationProviderError)) throw error;
        await this.connections.update(provider, {
          lastError: error.message,
          status: IntegrationStatus.error,
        });
        view.failed.push({ provider, error: error.message });
      }
    }

    await this.audit.record({
      action: AuditAction.update,
      entityType: 'Project',
      entityId: body.projectId,
      summary: `Verified ${view.checked} external references (${view.lost} lost)`,
      changes: {
        checked: view.checked,
        present: view.present,
        lost: view.lost,
        failed: view.failed.map((entry) => entry.provider),
      },
    });
    return view;
  }

  private async requireProject(projectId: string): Promise<void> {
    if ((await this.projects.findById(projectId)) === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(projectId);
  }

  private probeFor(
    provider: SyncProvider,
    context: AdapterContext,
  ): (reference: ExternalReference) => Promise<boolean> {
    switch (provider) {
      case 'jira':
        return async (reference) =>
          (await this.tracker.getIssue(context, reference.externalId)) !== null;
      case 'testrail':
        return async (reference) => {
          switch (reference.entityType) {
            case 'test_suite':
              return (await this.testManagement.fetchSuite(context, reference.externalId)) !== null;
            case 'test_case':
              return (await this.testManagement.fetchCase(context, reference.externalId)) !== null;
            case 'test_run':
              return (await this.testManagement.fetchRun(context, reference.externalId)) !== null;
            default:
              return (
                (await this.testManagement.fetchResult(context, reference.externalId)) !== null
              );
          }
        };
      case 'github': {
        const resultsByRun = new Map<string, Promise<AutomatedResult[]>>();
        return async (reference) => {
          const metadata = toStringRecord(reference.metadata);
          const repository = metadata['repositoryExternalId'] ?? '';
          if (reference.entityType === 'test_run') {
            return (
              (await this.automation.fetchWorkflowRun(
                context,
                repository,
                reference.externalId,
              )) !== null
            );
          }
          const runId = metadata['workflowRunExternalId'] ?? '';
          const key = `${repository}:${runId}`;
          let results = resultsByRun.get(key);
          if (results === undefined) {
            results = this.automation.fetchResults(context, repository, runId);
            resultsByRun.set(key, results);
          }
          return (await results).some((result) => result.externalId === reference.externalId);
        };
      }
    }
  }
}

// -- derivation -------------------------------------------------------------

interface RowContext {
  snapshot: EntitySnapshot | undefined;
  connection: IntegrationConnection | undefined;
  duplicate: boolean;
  shared: boolean;
}

function deriveRow(
  reference: ExternalReference,
  provider: SyncProvider,
  entityType: SyncableEntity,
  context: RowContext,
): ExternalTraceabilityRow {
  const metadata = toStringRecord(reference.metadata);
  const issues: ExternalTraceabilityIssue[] = [];
  let status: ExternalSyncStatus = 'synced';
  let error: string | null = null;
  const raise = (next: ExternalSyncStatus, issue: ExternalTraceabilityIssue): void => {
    issues.push(issue);
    if (SEVERITY[next] > SEVERITY[status]) status = next;
  };

  const { snapshot, connection } = context;
  if (snapshot === undefined) raise('error', 'orphaned_entity');
  else if (snapshot.state === 'deleted') raise('stale', 'deleted_entity');
  else if (snapshot.state === 'archived') raise('stale', 'archived_entity');

  if (context.duplicate) raise('error', 'duplicate_reference');
  if (context.shared) raise('error', 'shared_external_id');

  if (connection === undefined || reference.connectionId === null) {
    raise('linked', 'connection_missing');
  } else if (!connection.enabled) {
    raise('linked', 'connection_disabled');
  } else if (connection.status === IntegrationStatus.error) {
    raise('error', 'connection_error');
    error = connection.lastError;
  }

  if (metadata['providerState'] === 'missing') raise('stale', 'provider_lost');

  const syncedAt = metadata['syncedAt'] === undefined ? null : new Date(metadata['syncedAt']);
  if (syncedAt === null || Number.isNaN(syncedAt.getTime())) {
    raise('linked', 'never_synced');
  } else if (provider === 'github') {
    // A workflow-run link is an observation, not a push: it is current while
    // the run is over, and merely linked while the run is still moving.
    if (entityType === 'test_run' && metadata['status'] !== 'completed' && status === 'synced') {
      status = 'linked';
    }
  } else if (snapshot?.state === 'active' && snapshot.updatedAt > syncedAt) {
    raise('stale', 'entity_changed');
  }

  return {
    referenceId: reference.id,
    entityType,
    entityId: reference.entityId,
    entityKey: snapshot?.key ?? null,
    entityLabel: snapshot?.label ?? null,
    entityState: snapshot?.state ?? 'missing',
    parentEntityId: snapshot?.parentId ?? null,
    provider,
    externalKind: RELATIONS[provider][entityType] ?? 'issue',
    externalId: reference.externalId,
    externalKey: reference.externalKey,
    externalUrl: reference.externalUrl,
    metadata,
    previousExternalId: metadata['previousExternalId'] ?? null,
    status,
    issues,
    lastSyncAt:
      syncedAt === null || Number.isNaN(syncedAt.getTime()) ? null : syncedAt.toISOString(),
    lastVerifiedAt: metadata['verifiedAt'] ?? null,
    error,
    canResync: snapshot !== undefined && !NOT_RESYNCABLE.has(`${provider}:${entityType}`),
  };
}

function missingRow(
  provider: SyncProvider,
  entityType: SyncableEntity,
  snapshot: EntitySnapshot,
): ExternalTraceabilityRow {
  return {
    referenceId: null,
    entityType,
    entityId: snapshot.id,
    entityKey: snapshot.key,
    entityLabel: snapshot.label,
    entityState: snapshot.state,
    parentEntityId: snapshot.parentId,
    provider,
    externalKind: RELATIONS[provider][entityType] ?? 'issue',
    externalId: null,
    externalKey: null,
    externalUrl: null,
    metadata: {},
    previousExternalId: null,
    status: 'missing',
    issues: ['not_linked'],
    lastSyncAt: null,
    lastVerifiedAt: null,
    error: null,
    canResync: true,
  };
}

function summarise(
  provider: SyncProvider,
  connection: IntegrationConnection | undefined,
  rows: ExternalTraceabilityRow[],
): ExternalTraceabilityProviderSummary {
  return {
    provider,
    configured: connection !== undefined,
    enabled: connection?.enabled ?? false,
    connectionStatus: connection?.status ?? null,
    lastError: connection?.lastError ?? null,
    counts: countStatuses(rows.filter((row) => row.provider === provider)),
  };
}

function countStatuses(rows: ExternalTraceabilityRow[]): Record<ExternalSyncStatus, number> {
  const counts = Object.fromEntries(EXTERNAL_SYNC_STATUSES.map((status) => [status, 0])) as Record<
    ExternalSyncStatus,
    number
  >;
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

function byEntity(a: ExternalTraceabilityRow, b: ExternalTraceabilityRow): number {
  return (
    ORDER[a.entityType] - ORDER[b.entityType] ||
    (a.entityKey ?? '').localeCompare(b.entityKey ?? '') ||
    a.provider.localeCompare(b.provider)
  );
}

function isSupported(reference: ExternalReference): boolean {
  return (
    (SYNC_PROVIDERS as readonly string[]).includes(reference.provider) &&
    Object.keys(ORDER).includes(reference.entityType)
  );
}

function toContext(connection: IntegrationConnection): AdapterContext {
  return {
    organizationId: connection.organizationId,
    connectionId: connection.id,
    baseUrl: connection.baseUrl,
    secretRef: connection.secretRef,
    settings: toStringRecord(connection.settings),
  };
}

function toStringRecord(value: Prisma.JsonValue | null): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}
