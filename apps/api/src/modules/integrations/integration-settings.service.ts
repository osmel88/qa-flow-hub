import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, IntegrationConnection, IntegrationStatus, Prisma } from '@prisma/client';
import {
  CONFIGURABLE_INTEGRATION_PROVIDERS,
  ConfigurableIntegrationProvider,
  IntegrationConnectionView,
  IntegrationTestResultView,
  UpsertIntegrationInput,
} from '@qa-flow-hub/shared';
import {
  AUTOMATION_PROVIDER_ADAPTER,
  AdapterContext,
  AutomationProviderAdapter,
  HealthCheck,
  IssueTrackerAdapter,
  ISSUE_TRACKER_ADAPTER,
  TestManagementAdapter,
  TEST_MANAGEMENT_ADAPTER,
} from '../../integrations';
import { NotFoundError, ValidationError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { IntegrationSettingsRepository } from './integration-settings.repository';
import { PROVIDER_AVAILABILITY } from './provider-availability';

const ENTITY_TYPE = 'IntegrationConnection';

/**
 * Only string values survive. The column is `Json`, so a caller that bypassed
 * validation — a seed, a migration, a future phase — could have written
 * anything, and the contract promises a flat record of strings to the client.
 */
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

@Injectable()
export class IntegrationSettingsService {
  constructor(
    private readonly connections: IntegrationSettingsRepository,
    private readonly audit: AuditService,
    @Inject(ISSUE_TRACKER_ADAPTER) private readonly issueTracker: IssueTrackerAdapter,
    @Inject(TEST_MANAGEMENT_ADAPTER) private readonly testManagement: TestManagementAdapter,
    @Inject(AUTOMATION_PROVIDER_ADAPTER) private readonly automation: AutomationProviderAdapter,
  ) {}

  /**
   * Always the three providers, configured or not.
   *
   * The screen is a list of providers, not a list of rows: an organization that
   * has never opened it still needs to see what it could connect. Unconfigured
   * providers come back with `id: null`, which is also what tells the client to
   * send a create rather than an edit.
   */
  async list(): Promise<IntegrationConnectionView[]> {
    const stored = await this.connections.list();
    const byProvider = new Map<string, IntegrationConnection>(
      stored.map((connection) => [connection.provider, connection]),
    );

    return CONFIGURABLE_INTEGRATION_PROVIDERS.map((provider) =>
      this.toView(provider, byProvider.get(provider) ?? null),
    );
  }

  async findOne(provider: ConfigurableIntegrationProvider): Promise<IntegrationConnectionView> {
    return this.toView(provider, await this.load(provider));
  }

  /**
   * One endpoint for create and edit.
   *
   * A provider has at most one connection per organization, so "create" and
   * "update" describe the same intent — *this is how Jira is configured here* —
   * and splitting them would only make the client ask which one it needs.
   */
  async upsert(
    provider: ConfigurableIntegrationProvider,
    input: UpsertIntegrationInput,
  ): Promise<IntegrationConnectionView> {
    this.assertModeIsAvailable(provider, input.mode);

    const availability = PROVIDER_AVAILABILITY[provider];
    const existing = await this.load(provider);
    const baseUrl = this.normaliseBaseUrl(provider, input.baseUrl);
    const displayName =
      input.displayName ?? existing?.displayName ?? availability.defaultDisplayName;

    if (existing === null) {
      const created = await this.connections.create({
        provider: provider,
        displayName,
        mode: input.mode,
        baseUrl,
        settings: input.settings ?? {},
        accountMetadata: input.accountMetadata ?? {},
      });

      await this.audit.record({
        action: AuditAction.create,
        entityType: ENTITY_TYPE,
        entityId: created.id,
        summary: `Configured the ${displayName} integration in ${input.mode} mode`,
        changes: { provider, mode: input.mode, baseUrl, enabled: false },
      });

      return this.toView(provider, created);
    }

    const updated = await this.requireUpdate(provider, {
      displayName,
      mode: input.mode,
      baseUrl,
      ...(input.settings === undefined ? {} : { settings: input.settings }),
      ...(input.accountMetadata === undefined ? {} : { accountMetadata: input.accountMetadata }),
    });

    await this.audit.record({
      action: AuditAction.update,
      entityType: ENTITY_TYPE,
      entityId: updated.id,
      summary: `Updated the ${displayName} integration configuration`,
      changes: {
        mode: { from: existing.mode, to: updated.mode },
        baseUrl: { from: existing.baseUrl, to: updated.baseUrl },
      },
    });

    return this.toView(provider, updated);
  }

  /**
   * Enables a configured connection.
   *
   * With no provider implementation the honest destination is `pending`, not
   * `connected`: the configuration is saved and active, and nothing has answered
   * yet. Reporting `connected` here would be the single most misleading thing
   * this module could do — every later phase would inherit a green light that
   * means nothing.
   */
  async connect(provider: ConfigurableIntegrationProvider): Promise<IntegrationConnectionView> {
    const existing = await this.requireExisting(provider);
    const availability = PROVIDER_AVAILABILITY[provider];
    this.assertModeIsAvailable(provider, existing.mode);

    const updated = await this.requireUpdate(provider, {
      enabled: true,
      status: availability.implemented ? IntegrationStatus.connected : IntegrationStatus.pending,
      lastError: null,
    });

    await this.audit.record({
      action: AuditAction.update,
      entityType: ENTITY_TYPE,
      entityId: updated.id,
      summary: `Connected the ${updated.displayName} integration`,
      changes: { enabled: true, status: { from: existing.status, to: updated.status } },
    });

    return this.toView(provider, updated);
  }

  /**
   * Disables the connection and keeps everything else.
   *
   * There is no delete: the row is what `ExternalReference` rows point at, and
   * dropping it would orphan the traceability a later phase builds on it.
   * Disconnecting also clears `secretRef` — when a credential store exists, the
   * revocation belongs exactly here.
   */
  async disconnect(provider: ConfigurableIntegrationProvider): Promise<IntegrationConnectionView> {
    const existing = await this.requireExisting(provider);

    const updated = await this.requireUpdate(provider, {
      enabled: false,
      status: IntegrationStatus.disconnected,
      secretRef: null,
      lastError: null,
    });

    await this.audit.record({
      action: AuditAction.update,
      entityType: ENTITY_TYPE,
      entityId: updated.id,
      summary: `Disconnected the ${updated.displayName} integration`,
      changes: { enabled: false, status: { from: existing.status, to: 'disconnected' } },
    });

    return this.toView(provider, updated);
  }

  /**
   * Asks the provider whether it is reachable and records when it was asked.
   *
   * The timestamp is written whatever the answer: "we last checked at 10:04 and
   * it failed" is the useful piece of information, and only writing it on
   * success would hide every failure.
   */
  async testConnection(
    provider: ConfigurableIntegrationProvider,
  ): Promise<IntegrationTestResultView> {
    const existing = await this.requireExisting(provider);
    const availability = PROVIDER_AVAILABILITY[provider];

    const check = availability.implemented
      ? await this.runAdapterCheck(provider, existing)
      : {
          reachable: false,
          message: availability.unavailableReason ?? 'This provider has no implementation yet',
          checkedAt: new Date(),
        };

    const status = this.statusAfterCheck(existing, check, availability.implemented);

    const updated = await this.requireUpdate(provider, {
      lastConnectionTestAt: check.checkedAt,
      status,
      lastError: status === IntegrationStatus.error ? check.message : null,
    });

    if (status !== existing.status) {
      await this.audit.record({
        action: AuditAction.update,
        entityType: ENTITY_TYPE,
        entityId: updated.id,
        summary: `Connection test changed the ${updated.displayName} integration status`,
        changes: { status: { from: existing.status, to: status }, reachable: check.reachable },
      });
    }

    return {
      provider,
      reachable: check.reachable,
      message: check.message,
      checkedAt: check.checkedAt.toISOString(),
      connection: this.toView(provider, updated),
    };
  }

  private statusAfterCheck(
    existing: IntegrationConnection,
    check: HealthCheck,
    implemented: boolean,
  ): IntegrationStatus {
    if (check.reachable) {
      return IntegrationStatus.connected;
    }
    if (implemented) {
      return existing.enabled ? IntegrationStatus.error : IntegrationStatus.disconnected;
    }
    return existing.enabled ? IntegrationStatus.pending : IntegrationStatus.disconnected;
  }

  /**
   * The adapter receives `secretRef`, never a credential: reading the secret is
   * the credential store's job, and it does not exist yet. This path is
   * unreachable while no provider is implemented, and it is wired anyway so the
   * phase that implements one changes a flag, not this service.
   */
  private runAdapterCheck(
    provider: ConfigurableIntegrationProvider,
    connection: IntegrationConnection,
  ): Promise<HealthCheck> {
    const context: AdapterContext = {
      organizationId: connection.organizationId,
      connectionId: connection.id,
      secretRef: connection.secretRef,
      settings: toStringRecord(connection.settings),
    };

    switch (provider) {
      case 'jira':
        return this.issueTracker.check(context);
      case 'testrail':
        return this.testManagement.check(context);
      case 'github':
        return this.automation.check(context);
    }
  }

  private assertModeIsAvailable(
    provider: ConfigurableIntegrationProvider,
    mode: IntegrationConnection['mode'],
  ): void {
    const availability = PROVIDER_AVAILABILITY[provider];
    if (!availability.modes.includes(mode)) {
      throw new ValidationError(`${provider} does not support ${mode} mode yet`, [
        {
          path: 'mode',
          message:
            availability.unavailableReason ?? `Supported modes: ${availability.modes.join(', ')}`,
        },
      ]);
    }
  }

  /**
   * A base URL is dropped for providers that do not use one instead of being
   * stored and ignored: a saved value that has no effect is a support call
   * waiting to happen.
   */
  private normaliseBaseUrl(
    provider: ConfigurableIntegrationProvider,
    baseUrl: string | null | undefined,
  ): string | null {
    if (!PROVIDER_AVAILABILITY[provider].usesBaseUrl) {
      return null;
    }
    return baseUrl ?? null;
  }

  private load(provider: ConfigurableIntegrationProvider): Promise<IntegrationConnection | null> {
    return this.connections.findByProvider(provider);
  }

  private async requireExisting(
    provider: ConfigurableIntegrationProvider,
  ): Promise<IntegrationConnection> {
    const existing = await this.load(provider);
    if (existing === null) {
      throw new NotFoundError('Integration connection');
    }
    return existing;
  }

  private async requireUpdate(
    provider: ConfigurableIntegrationProvider,
    data: Prisma.IntegrationConnectionUpdateManyMutationInput,
  ): Promise<IntegrationConnection> {
    const updated = await this.connections.update(provider, data);
    if (updated === null) {
      throw new NotFoundError('Integration connection');
    }
    return updated;
  }

  /**
   * The only place a connection becomes JSON, so the guarantee "no credential
   * leaves the API" is one function to read: `secretRef` becomes the boolean
   * `hasCredential` and nothing else about it is exposed.
   */
  private toView(
    provider: ConfigurableIntegrationProvider,
    connection: IntegrationConnection | null,
  ): IntegrationConnectionView {
    const availability = PROVIDER_AVAILABILITY[provider];
    const mode = connection?.mode ?? availability.modes[0] ?? 'mock';

    return {
      id: connection?.id ?? null,
      provider,
      displayName: connection?.displayName ?? availability.defaultDisplayName,
      mode,
      enabled: connection?.enabled ?? false,
      status: connection?.status ?? IntegrationStatus.disconnected,
      baseUrl: connection?.baseUrl ?? null,
      settings: toStringRecord(connection?.settings ?? null),
      accountMetadata: toStringRecord(connection?.accountMetadata ?? null),
      hasCredential: connection?.secretRef !== null && connection?.secretRef !== undefined,
      lastSyncedAt: connection?.lastSyncAt?.toISOString() ?? null,
      lastConnectionTestAt: connection?.lastConnectionTestAt?.toISOString() ?? null,
      lastError: connection?.lastError ?? null,
      availableModes: [...availability.modes],
      connectable: availability.implemented,
      unavailableReason: availability.unavailableReason,
      updatedAt: connection?.updatedAt.toISOString() ?? null,
    };
  }
}
