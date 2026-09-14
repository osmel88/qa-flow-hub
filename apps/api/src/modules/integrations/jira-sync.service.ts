import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  Defect,
  ExternalReference,
  IntegrationConnection,
  IntegrationStatus,
  Prisma,
  Requirement,
} from '@prisma/client';
import {
  ExternalIssueView,
  ExternalProjectView,
  ExternalReferenceView,
  IssueTrackerCatalogView,
  JiraSyncResultView,
  JiraSyncableEntity,
  ListExternalIssuesQuery,
} from '@qa-flow-hub/shared';
import {
  AdapterContext,
  ExternalRef,
  IssueKind,
  IssuePayload,
  IssueSummary,
  IssueTrackerAdapter,
  ISSUE_TRACKER_ADAPTER,
} from '../../integrations';
import {
  IntegrationNotConfiguredError,
  IntegrationProviderError,
  NotFoundError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { DefectsRepository } from '../defects/defects.repository';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { RequirementsRepository } from '../requirements/requirements.repository';
import { ExternalReferencesRepository } from './external-references.repository';
import { IntegrationSettingsRepository } from './integration-settings.repository';

const PROVIDER = 'jira' as const;
const DISPLAY_NAME = 'Jira';

/** A requirement's type decides what kind of issue it becomes; a defect is always a bug. */
const KIND_BY_REQUIREMENT_TYPE: Record<Requirement['type'], IssueKind> = {
  user_story: 'story',
  functional: 'task',
  non_functional: 'task',
  epic: 'story',
  bug_fix: 'bug',
};

/**
 * Pushes requirements and defects to the issue tracker and remembers the result.
 *
 * The service is written against `IssueTrackerAdapter`, not against the mock:
 * it never learns that the other side is simulated, and swapping in a real Jira
 * changes the module wiring and nothing in this file. Three rules hold it
 * together:
 *
 *  1. authorization first, provider second. The entity is loaded through its
 *     own tenant-scoped repository and `assertRouteAccess()` runs on its project
 *     before the adapter is called, so a caller who may not edit a requirement
 *     cannot create issues in its name either;
 *  2. one reference per entity and provider. A repeated sync finds the existing
 *     `ExternalReference` and updates the issue behind it instead of creating a
 *     second one — synchronising twice is an update, not a duplicate;
 *  3. the connection records what happened. `lastSyncAt` moves on success and
 *     `lastError` is written on failure, so the settings screen tells the truth
 *     without this service knowing the screen exists.
 */
@Injectable()
export class JiraSyncService {
  constructor(
    @Inject(ISSUE_TRACKER_ADAPTER) private readonly tracker: IssueTrackerAdapter,
    private readonly connections: IntegrationSettingsRepository,
    private readonly references: ExternalReferencesRepository,
    private readonly requirements: RequirementsRepository,
    private readonly defects: DefectsRepository,
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsRepository,
    private readonly audit: AuditService,
  ) {}

  async listProjects(): Promise<ExternalProjectView[]> {
    const context = await this.requireContext();
    return this.tracker.listProjects(context);
  }

  async describe(): Promise<IssueTrackerCatalogView> {
    const context = await this.requireContext();
    return this.tracker.describe(context);
  }

  async listIssues(query: ListExternalIssuesQuery): Promise<ExternalIssueView[]> {
    const context = await this.requireContext();
    const issues = await this.tracker.listIssues(context, {
      ...(query.projectKey === undefined ? {} : { projectKey: query.projectKey }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
    });
    return issues.map(toIssueView);
  }

  /**
   * Every Jira reference of one entity type inside a project, in one query.
   *
   * The list screens need "which of these rows already has an issue?" and asking
   * per row would be the N+1 the roadmap forbids; asking per project is one
   * round trip whatever the page size.
   */
  async listReferences(
    projectId: string,
    entityType: JiraSyncableEntity,
  ): Promise<ExternalReferenceView[]> {
    if ((await this.projects.findById(projectId)) === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(projectId);

    const entityIds =
      entityType === 'requirement'
        ? await this.requirements.listIds(projectId)
        : await this.defects.listIds(projectId);

    const references = await this.references.listForEntities(PROVIDER, entityType, entityIds);
    return references.map((reference) => toReferenceView(reference, entityType));
  }

  async syncRequirement(id: string): Promise<JiraSyncResultView> {
    const requirement = await this.requirements.findById(id);
    if (requirement === null) {
      throw new NotFoundError('Requirement');
    }
    await this.access.assertRouteAccess(requirement.projectId);

    return this.sync('requirement', requirement.id, requirement.projectId, requirement.key, {
      kind: KIND_BY_REQUIREMENT_TYPE[requirement.type],
      title: requirement.title,
      description: describeRequirement(requirement),
      severity: null,
      priority: requirement.priority,
      state: requirement.status,
      originKey: requirement.key,
      labels: requirement.tags,
    });
  }

  async syncDefect(id: string): Promise<JiraSyncResultView> {
    const defect = await this.defects.findById(id);
    if (defect === null) {
      throw new NotFoundError('Defect');
    }
    await this.access.assertRouteAccess(defect.projectId);

    return this.sync('defect', defect.id, defect.projectId, defect.key, {
      kind: 'bug',
      title: defect.title,
      description: describeDefect(defect),
      severity: defect.severity,
      priority: defect.priority,
      state: defect.status,
      originKey: defect.key,
      labels: [],
    });
  }

  private async sync(
    entityType: JiraSyncableEntity,
    entityId: string,
    projectId: string,
    entityKey: string,
    payload: IssuePayload,
  ): Promise<JiraSyncResultView> {
    const connection = await this.requireConnection();
    const context = toContext(connection);
    const existing = await this.references.findForEntity(PROVIDER, entityType, entityId);

    let ref: ExternalRef;
    let action: JiraSyncResultView['action'];
    try {
      if (existing === null) {
        ref = await this.tracker.createIssue(context, payload);
        action = 'created';
      } else {
        ({ ref, action } = await this.reconcile(context, existing, payload));
      }
    } catch (error) {
      await this.recordFailure(error);
      throw error;
    }

    const metadata = toMetadata(ref);
    const reference =
      existing === null
        ? await this.references.create({
            provider: PROVIDER,
            entityType,
            entityId,
            projectId,
            externalId: ref.externalId,
            externalKey: ref.externalKey ?? null,
            externalUrl: ref.externalUrl ?? null,
            metadata,
            connectionId: connection.id,
          })
        : await this.replaceReference(existing, ref, metadata, connection.id);

    await this.connections.update(PROVIDER, {
      lastSyncAt: new Date(),
      lastError: null,
      status: IntegrationStatus.connected,
    });

    await this.audit.record({
      action: AuditAction.update,
      entityType: entityType === 'requirement' ? 'Requirement' : 'Defect',
      entityId,
      summary: `${action === 'created' ? 'Created' : 'Updated'} ${DISPLAY_NAME} issue ${
        ref.externalKey ?? ref.externalId
      } from ${entityKey}`,
      changes: {
        provider: PROVIDER,
        action,
        externalId: ref.externalId,
        externalKey: ref.externalKey ?? null,
      },
    });

    const issue = await this.tracker.getIssue(context, ref.externalId);

    return {
      entityType,
      entityId,
      action,
      reference: toReferenceView(reference, entityType),
      issue: issue === null ? issueViewFromRef(ref, payload) : toIssueView(issue),
    };
  }

  /**
   * Updates the issue a reference points at, and recreates it if the provider
   * no longer knows it. For the mock this is what happens after a restart; for
   * a real Jira it is what happens after somebody deletes the issue by hand. In
   * both cases the alternative — a reference that points at nothing forever —
   * is worse than a fresh issue.
   */
  private async reconcile(
    context: AdapterContext,
    existing: ExternalReference,
    payload: IssuePayload,
  ): Promise<{ ref: ExternalRef; action: JiraSyncResultView['action'] }> {
    const state = await this.tracker.fetchIssueState(context, existing.externalId);
    if (state === null) {
      return { ref: await this.tracker.createIssue(context, payload), action: 'created' };
    }
    return {
      ref: await this.tracker.updateIssue(context, existing.externalId, payload),
      action: 'updated',
    };
  }

  /**
   * One reference per entity, always: when the provider had to recreate the
   * issue, the row moves to the new id and remembers the old one in metadata
   * instead of leaving a second row pointing at nothing.
   */
  private async replaceReference(
    existing: ExternalReference,
    ref: ExternalRef,
    metadata: Record<string, string>,
    connectionId: string,
  ): Promise<ExternalReference> {
    const moved = existing.externalId !== ref.externalId;
    const updated = await this.references.update(existing.id, {
      externalId: ref.externalId,
      externalKey: ref.externalKey ?? null,
      externalUrl: ref.externalUrl ?? null,
      metadata: moved ? { ...metadata, previousExternalId: existing.externalId } : metadata,
      connectionId,
    });
    if (updated === null) {
      throw new NotFoundError('External reference');
    }
    return updated;
  }

  private async recordFailure(error: unknown): Promise<void> {
    // Only provider failures are the connection's business; a bug in this
    // service must not paint the integration red.
    if (!(error instanceof IntegrationProviderError)) {
      return;
    }
    await this.connections.update(PROVIDER, {
      lastError: error.message,
      status: IntegrationStatus.error,
    });
  }

  private async requireContext(): Promise<AdapterContext> {
    return toContext(await this.requireConnection());
  }

  /**
   * Connected means configured, enabled and in mock mode. A disconnected Jira
   * refuses to sync rather than silently creating issues an administrator
   * believed were not being created.
   */
  private async requireConnection(): Promise<IntegrationConnection> {
    const connection = await this.connections.findByProvider(PROVIDER);
    if (connection === null) {
      throw new IntegrationNotConfiguredError(
        DISPLAY_NAME,
        'configure it under Settings → Integrations first',
      );
    }
    if (!connection.enabled) {
      throw new IntegrationNotConfiguredError(DISPLAY_NAME, 'the integration is disconnected');
    }
    if (connection.mode !== 'mock') {
      throw new IntegrationNotConfiguredError(
        DISPLAY_NAME,
        `${connection.mode} mode has no provider yet`,
      );
    }
    return connection;
  }
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

function toMetadata(ref: ExternalRef): Record<string, string> {
  const metadata: Record<string, string> = { syncedAt: new Date().toISOString() };
  for (const [key, entry] of Object.entries(ref.metadata ?? {})) {
    if (typeof entry === 'string') {
      metadata[key] = entry;
    }
  }
  return metadata;
}

function toReferenceView(
  reference: ExternalReference,
  entityType: JiraSyncableEntity,
): ExternalReferenceView {
  return {
    id: reference.id,
    provider: PROVIDER,
    entityType,
    entityId: reference.entityId,
    externalId: reference.externalId,
    externalKey: reference.externalKey,
    externalUrl: reference.externalUrl,
    metadata: toStringRecord(reference.metadata),
    connectionId: reference.connectionId,
    createdAt: reference.createdAt.toISOString(),
    updatedAt: reference.updatedAt.toISOString(),
  };
}

function toIssueView(issue: IssueSummary): ExternalIssueView {
  return {
    externalId: issue.externalId,
    key: issue.key,
    url: issue.url,
    projectKey: issue.projectKey,
    kind: issue.kind,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    assignee: issue.assignee,
    labels: issue.labels,
    updatedAt: issue.updatedAt.toISOString(),
  };
}

/** When a provider cannot list what it just wrote, the reference is the best description. */
function issueViewFromRef(ref: ExternalRef, payload: IssuePayload): ExternalIssueView {
  const metadata = toMetadata(ref);
  return {
    externalId: ref.externalId,
    key: ref.externalKey ?? null,
    url: ref.externalUrl ?? null,
    projectKey: metadata['projectKey'] ?? null,
    kind: payload.kind,
    title: payload.title,
    status: metadata['status'] ?? payload.state,
    priority: metadata['priority'] ?? payload.priority,
    assignee: null,
    labels: payload.labels,
    updatedAt: new Date().toISOString(),
  };
}

function describeRequirement(requirement: Requirement): string | null {
  const parts = [requirement.description, requirement.acceptanceCriteria].filter(
    (part): part is string => part !== null && part.trim() !== '',
  );
  return parts.length === 0 ? null : parts.join('\n\n');
}

function describeDefect(defect: Defect): string | null {
  const parts = [
    defect.description,
    defect.stepsToReproduce === null ? null : `Steps to reproduce:\n${defect.stepsToReproduce}`,
    defect.environment === null ? null : `Environment: ${defect.environment}`,
  ].filter((part): part is string => part !== null && part.trim() !== '');
  return parts.length === 0 ? null : parts.join('\n\n');
}
