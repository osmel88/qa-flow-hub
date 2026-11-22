import type { ApiKeyState, ApiKeyView, CreatedApiKeyView } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, TextField } from '@qa-flow-hub/ui';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { automationApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';

/**
 * API keys let CI upload JUnit XML or Playwright JSON reports into this
 * project. The token is shown once, right after it is created: the API keeps
 * only its hash, so nobody (us included) can show it again.
 */
const STATE_TONE: Record<ApiKeyState, BadgeTone> = {
  active: 'success',
  expired: 'warning',
  revoked: 'neutral',
};

function formatDate(value: string | null): string {
  return value === null ? '—' : formatDateTime(value);
}

export function ApiKeysPage(): React.JSX.Element {
  const { activeProjectId, activeProject } = useProject();
  const queryClient = useQueryClient();
  const { can, isPending: permissionsPending } = useProjectPermissions(activeProjectId);
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('90');
  const [created, setCreated] = useState<CreatedApiKeyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectId = activeProjectId ?? '';
  const allowed = can('api_keys.manage');

  const keys = useQuery({
    queryKey: ['api-keys', activeProjectId],
    queryFn: () => automationApi.keys(projectId),
    // CI writes here outside this browser: last use and history must not be cached.
    staleTime: 0,
    refetchOnMount: 'always',
    enabled: activeProjectId !== null && allowed,
  });
  const reports = useQuery({
    queryKey: ['ingestion-reports', activeProjectId],
    queryFn: () => automationApi.reports(projectId),
    // CI writes here outside this browser: last use and history must not be cached.
    staleTime: 0,
    refetchOnMount: 'always',
    enabled: activeProjectId !== null && allowed,
  });

  const create = useMutation({
    mutationFn: () =>
      automationApi.createKey(projectId, {
        name: name.trim(),
        scopes: ['results:ingest'],
        expiresInDays: expiresInDays === '' ? null : Number(expiresInDays),
      }),
    onSuccess: async (result) => {
      setError(null);
      setCreated(result);
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('apiKeys.couldNotCreateTheKey'));
    },
  });

  const revoke = useMutation({
    mutationFn: (key: ApiKeyView) => automationApi.revokeKey(projectId, key.id),
    onSuccess: async (key) => {
      setError(null);
      if (created?.key.id === key.id) {
        setCreated(null);
      }
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('apiKeys.couldNotRevokeTheKey'));
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  if (!permissionsPending && !allowed) {
    return (
      <>
        <PageHeader title={t('apiKeys.apiKeys')} />
        <p className="card">{t('apiKeys.youDoNotHavePermission')}</p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('apiKeys.apiKeysFor', { value: activeProject?.key ?? 'this project' })}
        description={t('apiKeys.aKeyCanOnlyUpload')}
      />

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <form
        className="card form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <TextField
          label={t('apiKeys.keyName')}
          value={name}
          maxLength={100}
          required
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <TextField
          label={t('apiKeys.expiresInDays')}
          type="number"
          min={1}
          max={365}
          value={expiresInDays}
          hint={t('apiKeys.leaveEmptyForAKey')}
          onChange={(event) => {
            setExpiresInDays(event.target.value);
          }}
        />
        <div className="row-actions">
          <Button type="submit" disabled={name.trim() === '' || create.isPending}>
            {create.isPending ? t('apiKeys.creating') : t('apiKeys.createKey')}
          </Button>
        </div>
      </form>

      {created !== null && (
        <section className="card" aria-labelledby="new-key-heading">
          <h2 id="new-key-heading">{t('apiKeys.copyTheTokenNow')}</h2>
          <p>{t('apiKeys.itWillNotBeShown')}</p>
          <label className="ui-field">
            <span className="ui-field__label">{t('apiKeys.newApiKeyToken')}</span>
            <input className="ui-input" readOnly value={created.token} />
          </label>
          <div className="row-actions">
            <Button
              variant="secondary"
              onClick={() => {
                setCreated(null);
              }}
            >
              {t('apiKeys.iHaveCopiedIt')}
            </Button>
          </div>
        </section>
      )}

      <DataState
        isPending={keys.isPending}
        error={keys.error}
        isEmpty={(keys.data?.length ?? 0) === 0}
      >
        <table className="table card">
          <caption className="visually-hidden">{t('apiKeys.apiKeysOfThisProject')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('apiKeys.name')}</th>
              <th scope="col">{t('apiKeys.prefix')}</th>
              <th scope="col">{t('apiKeys.state')}</th>
              <th scope="col">{t('apiKeys.expires')}</th>
              <th scope="col">{t('apiKeys.lastUsed')}</th>
              <th scope="col">{t('apiKeys.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {keys.data?.map((key) => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td>
                  <code>{key.prefix}</code>
                </td>
                <td>
                  <Badge tone={STATE_TONE[key.state]}>{key.state}</Badge>
                </td>
                <td>{formatDate(key.expiresAt)}</td>
                <td>{formatDate(key.lastUsedAt)}</td>
                <td>
                  {key.state !== 'revoked' && (
                    <Button
                      variant="secondary"
                      aria-label={t('apiKeys.revoke', { name: key.name })}
                      disabled={revoke.isPending}
                      onClick={() => {
                        revoke.mutate(key);
                      }}
                    >
                      {t('apiKeys.revoke2')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>

      <h2>{t('apiKeys.ingestedReports')}</h2>
      <DataState
        isPending={reports.isPending}
        error={reports.error}
        isEmpty={(reports.data?.length ?? 0) === 0}
      >
        <table className="table card">
          <caption className="visually-hidden">{t('apiKeys.reportsUploadedWithApiKeys')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('apiKeys.file')}</th>
              <th scope="col">{t('apiKeys.format')}</th>
              <th scope="col">{t('apiKeys.tests')}</th>
              <th scope="col">{t('apiKeys.recorded')}</th>
              <th scope="col">{t('apiKeys.unmatched')}</th>
              <th scope="col">{t('apiKeys.key')}</th>
              <th scope="col">{t('apiKeys.received')}</th>
            </tr>
          </thead>
          <tbody>
            {reports.data?.map((report) => (
              <tr key={report.id}>
                <td>{report.fileName}</td>
                <td>
                  {report.format === 'junit_xml'
                    ? t('apiKeys.junitXml')
                    : t('apiKeys.playwrightJson')}
                </td>
                <td>{report.summary.tests}</td>
                <td>{report.summary.recorded}</td>
                <td>{report.summary.unmatched}</td>
                <td>{report.apiKeyPrefix === null ? '—' : <code>{report.apiKeyPrefix}</code>}</td>
                <td>{formatDate(report.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
