import { roleHasPermission } from '@qa-flow-hub/shared';
import type { IntegrationConnectionView, IntegrationMode } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { integrationsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { t } from '../i18n/i18n';
import { validationMessage } from '../i18n/validation';
import { formatDateTime } from '../i18n/format';

function formatMoment(value: string | null): string {
  return formatDateTime(value, t('integrations.never'));
}

/**
 * `settings` and `accountMetadata` are open-ended records, so the form edits
 * them as `key=value` lines. A schema-driven form per provider would be nicer
 * and cannot be written yet: the keys each provider needs are decided by the
 * phase that implements it.
 */
function toLines(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function parseLines(text: string): Record<string, string> | null {
  const entries: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      return null;
    }
    entries[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return entries;
}

function IntegrationCard({
  connection,
  canManage,
}: {
  connection: IntegrationConnectionView;
  canManage: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const provider = connection.provider;
  const [mode, setMode] = useState<IntegrationMode>(connection.mode);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? '');
  const [settings, setSettings] = useState(toLines(connection.settings));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['integrations'] });
  };

  const fail = (cause: unknown, fallback: string): void => {
    setNotice(null);
    if (cause instanceof ApiError && cause.details !== undefined && cause.details.length > 0) {
      setError(cause.details.map((detail) => validationMessage(detail.message)).join(' '));
      return;
    }
    setError(cause instanceof Error ? cause.message : fallback);
  };

  const save = useMutation({
    mutationFn: () => {
      const parsed = parseLines(settings);
      if (parsed === null) {
        return Promise.reject(new Error(t('integrations.useOneKeyValuePerLine')));
      }
      return integrationsApi.save(provider, {
        mode,
        baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
        settings: parsed,
      });
    },
    onSuccess: async () => {
      setError(null);
      setNotice(t('integrations.configurationSaved'));
      await refresh();
    },
    onError: (cause) => {
      fail(cause, t('integrations.couldNotSaveTheConfiguration'));
    },
  });

  const connect = useMutation({
    mutationFn: () => integrationsApi.connect(provider),
    onSuccess: async (updated) => {
      setError(null);
      setNotice(
        updated.status === 'pending'
          ? (updated.unavailableReason ?? t('integrations.enabledWaitingForAProvider'))
          : t('integrations.connected'),
      );
      await refresh();
    },
    onError: (cause) => {
      fail(cause, t('integrations.couldNotConnect'));
    },
  });

  const disconnect = useMutation({
    mutationFn: () => integrationsApi.disconnect(provider),
    onSuccess: async () => {
      setError(null);
      setNotice(t('integrations.disconnectedTheConfigurationAndIts'));
      await refresh();
    },
    onError: (cause) => {
      fail(cause, t('integrations.couldNotDisconnect'));
    },
  });

  const test = useMutation({
    mutationFn: () => integrationsApi.testConnection(provider),
    onSuccess: async (result) => {
      setError(null);
      setNotice(result.message);
      await refresh();
    },
    onError: (cause) => {
      fail(cause, t('integrations.couldNotTestTheConnection'));
    },
  });

  const busy = save.isPending || connect.isPending || disconnect.isPending || test.isPending;
  const isConfigured = connection.id !== null;

  return (
    <section className="card" aria-labelledby={`integration-${provider}`}>
      <h2 id={`integration-${provider}`}>{connection.displayName}</h2>
      <p>
        <Badge tone={toneFor(connection.status)}>{humanize(connection.status)}</Badge>{' '}
        <Badge tone="neutral">
          {connection.mode === 'mock' ? t('integrations.mock') : t('integrations.real')}
        </Badge>{' '}
        <Badge tone={connection.enabled ? 'success' : 'neutral'}>
          {connection.enabled ? t('integrations.enabled') : t('integrations.disabled')}
        </Badge>
      </p>

      {connection.unavailableReason !== null && (
        <p className="muted">{connection.unavailableReason}</p>
      )}

      <dl className="detail-list">
        <dt>{t('integrations.lastSynchronised')}</dt>
        <dd>{formatMoment(connection.lastSyncedAt)}</dd>
        <dt>{t('integrations.lastConnectionTest')}</dt>
        <dd>{formatMoment(connection.lastConnectionTestAt)}</dd>
        <dt>{t('integrations.credential')}</dt>
        <dd>{connection.hasCredential ? t('integrations.stored') : t('integrations.none')}</dd>
        {Object.entries(connection.accountMetadata).map(([key, value]) => (
          <div key={key}>
            <dt>{humanize(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {connection.lastError !== null && (
        <p className="ui-field__error" role="alert">
          {connection.lastError}
        </p>
      )}

      {canManage && (
        <>
          <SelectField
            label={t('integrations.mode')}
            hint={t('integrations.whichSideOfTheProvider')}
            options={connection.availableModes.map((value) => ({
              value,
              label: value === 'mock' ? t('integrations.mock') : t('integrations.real'),
            }))}
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as IntegrationMode);
            }}
          />
          {provider !== 'github' && (
            <TextField
              label={t('integrations.baseUrl')}
              hint={t('integrations.absoluteHttpSUrlOf')}
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
              }}
            />
          )}
          <TextAreaField
            label={t('integrations.configuration')}
            hint={t('integrations.oneKeyValuePairPer')}
            rows={3}
            value={settings}
            onChange={(event) => {
              setSettings(event.target.value);
            }}
          />

          <div className="row">
            <Button
              loading={save.isPending}
              disabled={busy}
              onClick={() => {
                save.mutate();
              }}
            >
              {t('integrations.save')}
            </Button>
            <Button
              variant="secondary"
              loading={test.isPending}
              disabled={busy || !isConfigured}
              onClick={() => {
                test.mutate();
              }}
            >
              {t('integrations.testConnection')}
            </Button>
            {connection.enabled ? (
              <Button
                variant="secondary"
                loading={disconnect.isPending}
                disabled={busy}
                onClick={() => {
                  disconnect.mutate();
                }}
              >
                {t('integrations.disconnect')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                loading={connect.isPending}
                disabled={busy || !isConfigured}
                onClick={() => {
                  connect.mutate();
                }}
              >
                {t('integrations.connect')}
              </Button>
            )}
          </div>

          {!isConfigured && (
            <p className="muted">{t('integrations.saveTheConfigurationBeforeConnecting')}</p>
          )}
        </>
      )}

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {notice !== null && error === null && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

/**
 * Settings → Integrations.
 *
 * The screen is a list of providers rather than of saved rows, and every
 * limitation is stated where it applies: Jira and TestRail wait for their mock
 * providers, GitHub waits for the credential store. No secret is entered here,
 * because this build has nowhere safe to keep one.
 */
export function IntegrationsPage(): React.JSX.Element {
  const { activeOrganization } = useAuth();
  const role = activeOrganization?.role ?? null;
  // Same check as `@RequirePermission('integrations.manage')` on the settings routes.
  const canManage = role !== null && roleHasPermission(role, 'integrations.manage');

  const integrations = useQuery({
    queryKey: ['integrations', activeOrganization?.id],
    queryFn: () => integrationsApi.list(),
  });

  return (
    <>
      <PageHeader
        title={t('integrations.integrations')}
        description={t('integrations.perOrganizationConfigurationOfJira')}
      />

      {!canManage && <p className="muted">{t('integrations.onlyOrganizationOwnersAndAdmins')}</p>}

      <DataState
        isPending={integrations.isPending}
        error={integrations.error}
        isEmpty={(integrations.data?.length ?? 0) === 0}
      >
        {integrations.data?.map((connection) => (
          <IntegrationCard
            key={connection.provider}
            connection={connection}
            canManage={canManage}
          />
        ))}
      </DataState>
    </>
  );
}
