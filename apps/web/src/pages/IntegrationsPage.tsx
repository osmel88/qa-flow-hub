import type { IntegrationConnectionView, IntegrationMode } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { integrationsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';

function formatMoment(value: string | null): string {
  return value === null ? 'never' : new Date(value).toLocaleString();
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
      setError(cause.details.map((detail) => detail.message).join(' '));
      return;
    }
    setError(cause instanceof Error ? cause.message : fallback);
  };

  const save = useMutation({
    mutationFn: () => {
      const parsed = parseLines(settings);
      if (parsed === null) {
        return Promise.reject(new Error('Use one key=value pair per line.'));
      }
      return integrationsApi.save(provider, {
        mode,
        baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
        settings: parsed,
      });
    },
    onSuccess: async () => {
      setError(null);
      setNotice('Configuration saved.');
      await refresh();
    },
    onError: (cause) => {
      fail(cause, 'Could not save the configuration.');
    },
  });

  const connect = useMutation({
    mutationFn: () => integrationsApi.connect(provider),
    onSuccess: async (updated) => {
      setError(null);
      setNotice(
        updated.status === 'pending'
          ? (updated.unavailableReason ?? 'Enabled, waiting for a provider implementation.')
          : 'Connected.',
      );
      await refresh();
    },
    onError: (cause) => {
      fail(cause, 'Could not connect.');
    },
  });

  const disconnect = useMutation({
    mutationFn: () => integrationsApi.disconnect(provider),
    onSuccess: async () => {
      setError(null);
      setNotice('Disconnected. The configuration and its references were kept.');
      await refresh();
    },
    onError: (cause) => {
      fail(cause, 'Could not disconnect.');
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
      fail(cause, 'Could not test the connection.');
    },
  });

  const busy = save.isPending || connect.isPending || disconnect.isPending || test.isPending;
  const isConfigured = connection.id !== null;

  return (
    <section className="card" aria-labelledby={`integration-${provider}`}>
      <h2 id={`integration-${provider}`}>{connection.displayName}</h2>
      <p>
        <Badge tone={toneFor(connection.status)}>{humanize(connection.status)}</Badge>{' '}
        <Badge tone="neutral">{connection.mode === 'mock' ? 'Mock' : 'Real'}</Badge>{' '}
        <Badge tone={connection.enabled ? 'success' : 'neutral'}>
          {connection.enabled ? 'Enabled' : 'Disabled'}
        </Badge>
      </p>

      {connection.unavailableReason !== null && (
        <p className="muted">{connection.unavailableReason}</p>
      )}

      <dl className="detail-list">
        <dt>Last synchronised</dt>
        <dd>{formatMoment(connection.lastSyncedAt)}</dd>
        <dt>Last connection test</dt>
        <dd>{formatMoment(connection.lastConnectionTestAt)}</dd>
        <dt>Credential</dt>
        <dd>{connection.hasCredential ? 'Stored' : 'None'}</dd>
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
            label="Mode"
            hint="Which side of the provider this organization talks to."
            options={connection.availableModes.map((value) => ({
              value,
              label: value === 'mock' ? 'Mock' : 'Real',
            }))}
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as IntegrationMode);
            }}
          />
          {provider !== 'github' && (
            <TextField
              label="Base URL"
              hint="Absolute http(s) URL of the provider instance."
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
              }}
            />
          )}
          <TextAreaField
            label="Configuration"
            hint="One key=value pair per line. Credentials are not accepted here."
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
              Save
            </Button>
            <Button
              variant="secondary"
              loading={test.isPending}
              disabled={busy || !isConfigured}
              onClick={() => {
                test.mutate();
              }}
            >
              Test connection
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
                Disconnect
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
                Connect
              </Button>
            )}
          </div>

          {!isConfigured && <p className="muted">Save the configuration before connecting.</p>}
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
  const canManage = role === 'organization_owner' || role === 'organization_admin';

  const integrations = useQuery({
    queryKey: ['integrations', activeOrganization?.id],
    queryFn: () => integrationsApi.list(),
  });

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Per-organization configuration of Jira, TestRail and GitHub. Credentials are never shown, and no token is accepted until the encrypted credential store exists."
      />

      {!canManage && (
        <p className="muted">
          Only organization owners and admins can change these settings. You can see how they are
          configured.
        </p>
      )}

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
