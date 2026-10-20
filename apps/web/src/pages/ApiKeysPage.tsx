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
  return value === null ? '—' : new Date(value).toLocaleString();
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
      setError(cause instanceof ApiError ? cause.message : 'Could not create the key.');
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
      setError(cause instanceof ApiError ? cause.message : 'Could not revoke the key.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  if (!permissionsPending && !allowed) {
    return (
      <>
        <PageHeader title="API keys" />
        <p className="card">You do not have permission to manage API keys in this project.</p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`API keys for ${activeProject?.key ?? 'this project'}`}
        description="A key can only upload test reports (JUnit XML or Playwright JSON) into this project. Revoking it takes effect on the very next request."
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
          label="Key name"
          value={name}
          maxLength={100}
          required
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <TextField
          label="Expires in days"
          type="number"
          min={1}
          max={365}
          value={expiresInDays}
          hint="Leave empty for a key that never expires."
          onChange={(event) => {
            setExpiresInDays(event.target.value);
          }}
        />
        <div className="row-actions">
          <Button type="submit" disabled={name.trim() === '' || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create key'}
          </Button>
        </div>
      </form>

      {created !== null && (
        <section className="card" aria-labelledby="new-key-heading">
          <h2 id="new-key-heading">Copy the token now</h2>
          <p>It will not be shown again. Store it as a CI secret, for example QAFLOW_API_KEY.</p>
          <label className="ui-field">
            <span className="ui-field__label">New API key token</span>
            <input className="ui-input" readOnly value={created.token} />
          </label>
          <div className="row-actions">
            <Button
              variant="secondary"
              onClick={() => {
                setCreated(null);
              }}
            >
              I have copied it
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
          <caption className="visually-hidden">API keys of this project</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Prefix</th>
              <th scope="col">State</th>
              <th scope="col">Expires</th>
              <th scope="col">Last used</th>
              <th scope="col">Actions</th>
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
                      aria-label={`Revoke ${key.name}`}
                      disabled={revoke.isPending}
                      onClick={() => {
                        revoke.mutate(key);
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>

      <h2>Ingested reports</h2>
      <DataState
        isPending={reports.isPending}
        error={reports.error}
        isEmpty={(reports.data?.length ?? 0) === 0}
      >
        <table className="table card">
          <caption className="visually-hidden">Reports uploaded with API keys</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Format</th>
              <th scope="col">Tests</th>
              <th scope="col">Recorded</th>
              <th scope="col">Unmatched</th>
              <th scope="col">Key</th>
              <th scope="col">Received</th>
            </tr>
          </thead>
          <tbody>
            {reports.data?.map((report) => (
              <tr key={report.id}>
                <td>{report.fileName}</td>
                <td>{report.format === 'junit_xml' ? 'JUnit XML' : 'Playwright JSON'}</td>
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
