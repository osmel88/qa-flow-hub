import {
  EXTERNAL_SYNC_STATUSES,
  SYNCABLE_ENTITIES,
  SYNC_PROVIDERS,
  type ExternalSyncStatus,
  type ExternalTraceabilityQuery,
  type ExternalTraceabilityRow,
  type ExternalTraceabilityVerificationView,
  type SyncProvider,
  type SyncableEntity,
} from '@qa-flow-hub/shared';
import { Badge, type BadgeTone, Button, DataState } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { externalTraceabilityApi, gitHubApi, jiraApi, testRailApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';

const STATUS_TONES: Record<ExternalSyncStatus, BadgeTone> = {
  synced: 'success',
  linked: 'info',
  stale: 'warning',
  missing: 'neutral',
  error: 'danger',
};

const PROVIDER_LABELS: Record<SyncProvider, string> = {
  get jira() {
    return t('externalTraceability.jira');
  },
  get testrail() {
    return t('externalTraceability.testrail');
  },
  get github() {
    return t('externalTraceability.github');
  },
};

function formatDate(value: string | null): string {
  return value === null ? '—' : formatDateTime(value);
}

/**
 * Re-sync goes through the provider endpoints that already exist; this page
 * adds no sync logic of its own. GitHub can only refresh a linked run here —
 * choosing a workflow run needs the picker on the execution screen.
 */
function resync(row: ExternalTraceabilityRow): Promise<unknown> {
  switch (row.provider) {
    case 'jira':
      return jiraApi.sync(row.entityType === 'defect' ? 'defect' : 'requirement', row.entityId);
    case 'testrail':
      if (row.entityType === 'requirement' || row.entityType === 'defect') {
        return Promise.reject(new Error(t('externalTraceability.testrailDoesNotTrack')));
      }
      return testRailApi.sync(row.entityType, row.entityId);
    case 'github':
      return gitHubApi.linkRun(row.entityId, null);
  }
}

/**
 * External traceability: every link from this project into Jira, TestRail and
 * GitHub, in one table. Deliberately not the internal matrix (`/traceability`),
 * which relates our own entities to each other, and deliberately not a KPI
 * board: it answers "is this link healthy, and if not, why" per row.
 */
export function ExternalTraceabilityPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<SyncProvider | ''>('');
  const [entityType, setEntityType] = useState<SyncableEntity | ''>('');
  const [status, setStatus] = useState<ExternalSyncStatus | ''>('');
  const [includeMissing, setIncludeMissing] = useState(true);
  const [verification, setVerification] = useState<ExternalTraceabilityVerificationView | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const params: ExternalTraceabilityQuery = {
    projectId: activeProjectId ?? '',
    includeMissing: includeMissing ? 'true' : 'false',
    ...(provider === '' ? {} : { provider }),
    ...(entityType === '' ? {} : { entityType }),
    ...(status === '' ? {} : { status }),
  };

  const view = useQuery({
    queryKey: ['external-traceability', params],
    queryFn: () => externalTraceabilityApi.list(params),
    enabled: activeProjectId !== null,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['external-traceability'] });
  };

  const verify = useMutation({
    mutationFn: () => externalTraceabilityApi.verify(activeProjectId ?? ''),
    onSuccess: async (result) => {
      setError(null);
      setVerification(result);
      await invalidate();
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError
          ? cause.message
          : t('externalTraceability.couldNotVerifyTheReferences'),
      );
    },
  });

  const sync = useMutation({
    mutationFn: resync,
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : t('externalTraceability.couldNotReSync'));
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <>
      <PageHeader
        title={t('externalTraceability.externalTraceability')}
        description={t('externalTraceability.everyLinkFromThisProject')}
        actions={
          <Button
            variant="secondary"
            loading={verify.isPending}
            onClick={() => {
              verify.mutate();
            }}
          >
            {t('externalTraceability.verifyWithProviders')}
          </Button>
        }
      />

      <section className="card filters" aria-label={t('externalTraceability.filters')}>
        <label className="ui-field">
          <span className="ui-field__label">{t('externalTraceability.provider')}</span>
          <select
            className="ui-input"
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as SyncProvider | '');
            }}
          >
            <option value="">{t('externalTraceability.allProviders')}</option>
            {SYNC_PROVIDERS.map((value) => (
              <option key={value} value={value}>
                {PROVIDER_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="ui-field">
          <span className="ui-field__label">{t('externalTraceability.entityType')}</span>
          <select
            className="ui-input"
            value={entityType}
            onChange={(event) => {
              setEntityType(event.target.value as SyncableEntity | '');
            }}
          >
            <option value="">{t('externalTraceability.allEntities')}</option>
            {SYNCABLE_ENTITIES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="ui-field">
          <span className="ui-field__label">{t('externalTraceability.status')}</span>
          <select
            className="ui-input"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as ExternalSyncStatus | '');
            }}
          >
            <option value="">{t('externalTraceability.allStatuses')}</option>
            {EXTERNAL_SYNC_STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeMissing}
            onChange={(event) => {
              setIncludeMissing(event.target.checked);
            }}
          />
          {t('externalTraceability.showEntitiesNotLinkedYet')}
        </label>
      </section>

      {view.data !== undefined && (
        <section className="card" aria-label={t('externalTraceability.summary')}>
          <p className="row-actions">
            {EXTERNAL_SYNC_STATUSES.map((value) => (
              <Badge key={value} tone={STATUS_TONES[value]}>
                {humanize(value)}: {view.data.counts[value]}
              </Badge>
            ))}
          </p>
          <ul className="plain-list">
            {view.data.providers.map((summary) => (
              <li key={summary.provider}>
                <strong>{PROVIDER_LABELS[summary.provider]}</strong>{' '}
                {summary.configured ? (
                  <Badge tone={summary.connectionStatus === 'connected' ? 'success' : 'warning'}>
                    {humanize(summary.connectionStatus ?? 'disconnected')}
                  </Badge>
                ) : (
                  <Badge tone="neutral">{t('externalTraceability.notConfigured')}</Badge>
                )}
                {summary.lastError !== null && (
                  <span className="muted"> — {summary.lastError}</span>
                )}
              </li>
            ))}
          </ul>
          {verification !== null && (
            <p role="status">
              {t('externalTraceability.verified')} {verification.checked}{' '}
              {t('externalTraceability.references')} {verification.present}{' '}
              {t('externalTraceability.present')} {verification.lost}{' '}
              {t('externalTraceability.lost')}
              {verification.failed.length > 0 &&
                `, ${verification.failed.map((f) => `${PROVIDER_LABELS[f.provider]}: ${f.error}`).join('; ')}`}
              .
            </p>
          )}
        </section>
      )}

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <DataState
        isPending={view.isPending}
        error={view.error}
        isEmpty={(view.data?.rows.length ?? 0) === 0}
        emptyMessage={t('externalTraceability.noExternalReferencesMatchConnect')}
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">{t('externalTraceability.internalEntity')}</th>
              <th scope="col">{t('externalTraceability.provider')}</th>
              <th scope="col">{t('externalTraceability.externalEntity')}</th>
              <th scope="col">{t('externalTraceability.externalId')}</th>
              <th scope="col">{t('externalTraceability.syncStatus')}</th>
              <th scope="col">{t('externalTraceability.lastSync')}</th>
              <th scope="col">{t('externalTraceability.error')}</th>
              <th scope="col">{t('externalTraceability.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {view.data?.rows.map((row) => {
              const key = row.referenceId ?? `${row.provider}:${row.entityType}:${row.entityId}`;
              return (
                <tr key={key} data-status={row.status}>
                  <td>
                    <span className="muted">{humanize(row.entityType)}</span>{' '}
                    <code>{row.entityKey ?? row.entityId}</code>
                    {row.entityLabel !== null && row.entityLabel !== row.entityKey && (
                      <> {row.entityLabel}</>
                    )}
                    {row.entityState !== 'active' && (
                      <>
                        {' '}
                        <Badge tone="neutral">{humanize(row.entityState)}</Badge>
                      </>
                    )}
                  </td>
                  <td>{PROVIDER_LABELS[row.provider]}</td>
                  <td>{humanize(row.externalKind)}</td>
                  <td>
                    {row.externalId === null ? (
                      <span className="muted">—</span>
                    ) : row.externalUrl === null ? (
                      <code>{row.externalKey ?? row.externalId}</code>
                    ) : (
                      <a href={row.externalUrl} target="_blank" rel="noreferrer">
                        <code>{row.externalKey ?? row.externalId}</code>
                      </a>
                    )}
                    {row.previousExternalId !== null && (
                      <span className="muted">
                        {' '}
                        {t('externalTraceability.was')} {row.previousExternalId})
                      </span>
                    )}
                  </td>
                  <td>
                    <Badge tone={STATUS_TONES[row.status]}>{humanize(row.status)}</Badge>
                    {row.issues.length > 0 && (
                      <span className="muted"> {row.issues.map(humanize).join(', ')}</span>
                    )}
                  </td>
                  <td>
                    {formatDate(row.lastSyncAt)}
                    {row.lastVerifiedAt !== null && (
                      <span className="muted">
                        {' '}
                        {t('externalTraceability.verified2')} {formatDate(row.lastVerifiedAt)}
                      </span>
                    )}
                  </td>
                  <td>{row.error === null ? <span className="muted">—</span> : row.error}</td>
                  <td>
                    {row.canResync && (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={sync.isPending && sync.variables === row}
                        onClick={() => {
                          sync.mutate(row);
                        }}
                      >
                        {row.referenceId === null
                          ? t('externalTraceability.sync')
                          : t('externalTraceability.reSync')}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
