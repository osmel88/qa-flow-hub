import {
  ALL_DEVELOPMENT_STATUSES,
  DEVELOPMENT_ARTIFACT_KINDS,
  DEVELOPMENT_PROVIDERS,
  DEVELOPMENT_STATUS_VALUES,
  artifactReference,
  statusesFor,
} from '@qa-flow-hub/shared';
import type {
  CreateDevelopmentArtifactInput,
  DevelopmentArtifactKind,
  DevelopmentArtifactView,
  DevelopmentProvider,
} from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { developmentApi, workItemsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';

/** The label of the field that identifies an artifact of this kind. */
export function referenceLabel(kind: DevelopmentArtifactKind): string {
  switch (kind) {
    case 'branch':
      return t('development.branchName');
    case 'commit':
      return t('development.commitSha');
    case 'pull_request':
      return t('development.pullRequestNumber');
    case 'build':
      return t('development.buildIdentifier');
    default:
      return t('development.deploymentIdentifier');
  }
}

/** The create payload for the reference typed by the user. */
export function referenceFields(
  kind: DevelopmentArtifactKind,
  reference: string,
): Pick<CreateDevelopmentArtifactInput, 'branchName' | 'commitSha' | 'prNumber' | 'identifier'> {
  const value = reference.trim();
  switch (kind) {
    case 'branch':
      return { branchName: value };
    case 'commit':
      return { commitSha: value };
    case 'pull_request':
      return { prNumber: Number(value) };
    default:
      return { identifier: value };
  }
}

export const DEVELOPMENT_STATUS_TONE: Record<string, BadgeTone> = {
  succeeded: 'success',
  passed: 'success',
  deploying: 'info',
  running: 'info',
  merged: 'success',
  failed: 'danger',
  rolled_back: 'danger',
  closed: 'neutral',
  cancelled: 'neutral',
  deleted: 'neutral',
};

/** Kind, reference (linked to the provider URL when there is one) and status. */
export function ArtifactSummary({
  artifact,
}: {
  artifact: DevelopmentArtifactView;
}): React.JSX.Element {
  const reference = artifactReference(artifact);
  return (
    <>
      <Badge tone="neutral">{humanize(artifact.kind)}</Badge>{' '}
      {artifact.url === null ? (
        <code>{reference}</code>
      ) : (
        <a href={artifact.url} target="_blank" rel="noopener noreferrer">
          <code>{reference}</code>
        </a>
      )}{' '}
      {artifact.title !== null && <span>{artifact.title}</span>}{' '}
      {artifact.status !== null && (
        <Badge tone={DEVELOPMENT_STATUS_TONE[artifact.status] ?? 'info'}>
          {humanize(artifact.status)}
        </Badge>
      )}
    </>
  );
}

export function DevelopmentPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const [params] = useSearchParams();
  const [kind, setKind] = useState('');
  const [provider, setProvider] = useState('');
  const [status, setStatus] = useState('');
  const [workItemId, setWorkItemId] = useState(params.get('workItemId') ?? '');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    kind: 'pull_request' as DevelopmentArtifactKind,
    provider: 'local' as DevelopmentProvider,
    reference: '',
    title: '',
    status: '',
    environment: '',
    url: '',
    workItemId: params.get('workItemId') ?? '',
  });
  const projectId = activeProjectId ?? '';
  const trimmed = search.trim();
  const filters = {
    projectId,
    ...(kind === '' ? {} : { kind: kind as DevelopmentArtifactKind }),
    ...(provider === '' ? {} : { provider: provider as DevelopmentProvider }),
    ...(status === '' ? {} : { status }),
    ...(workItemId === '' ? {} : { workItemId }),
    ...(trimmed === '' ? {} : { search: trimmed }),
  };
  const artifacts = useQuery({
    queryKey: ['development', filters],
    queryFn: () => developmentApi.list(filters),
    enabled: activeProjectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const summary = useQuery({
    queryKey: ['development', 'summary', activeProjectId],
    queryFn: () => developmentApi.summary(projectId),
    enabled: activeProjectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const workItems = useQuery({
    queryKey: ['work-items', activeProjectId, 'development-candidates'],
    queryFn: () => workItemsApi.list({ projectId }),
    enabled: activeProjectId !== null,
  });

  const refresh = async (): Promise<void> => {
    await Promise.all(
      ['development', 'work-items'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };
  const onError = (cause: unknown): void => {
    setNotice(null);
    setError(cause instanceof ApiError ? cause.message : t('development.couldNotSaveTheChange'));
  };
  const create = useMutation({
    mutationFn: () =>
      developmentApi.create({
        projectId,
        kind: draft.kind,
        provider: draft.provider,
        ...referenceFields(draft.kind, draft.reference),
        ...(draft.title.trim() === '' ? {} : { title: draft.title.trim() }),
        ...(draft.status === '' ? {} : { status: draft.status }),
        ...(draft.kind !== 'deployment' || draft.environment.trim() === ''
          ? {}
          : { environment: draft.environment.trim() }),
        ...(draft.url.trim() === '' ? {} : { url: draft.url.trim() }),
        workItemIds: draft.workItemId === '' ? [] : [draft.workItemId],
      }),
    onSuccess: async (row) => {
      setError(null);
      setNotice(
        t('development.recorded', { value: humanize(row.kind), value2: artifactReference(row) }),
      );
      setDraft({ ...draft, reference: '', title: '', status: '', environment: '', url: '' });
      await refresh();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => developmentApi.remove(id),
    onSuccess: async () => {
      setError(null);
      setNotice(t('development.developmentArtifactDeleted'));
      await refresh();
    },
    onError,
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  const writable = can('work_items.write');
  const manager = can('work_items.manage');
  const items = workItems.data?.data ?? [];
  const rows = artifacts.data?.data ?? [];

  return (
    <>
      <PageHeader
        title={t('development.development')}
        description={t('development.branchesCommitsPullRequestsBuilds')}
      />
      {summary.data !== undefined && (
        <section className="card" aria-labelledby="development-summary">
          <h2 id="development-summary">{t('development.workItemsByDevelopmentStatus')}</h2>
          <dl className="kpis">
            {DEVELOPMENT_STATUS_VALUES.filter((value) => summary.data.workItems[value] > 0).map(
              (value) => (
                <div key={value}>
                  <dt>{humanize(value)}</dt>
                  <dd data-testid={`development-summary-${value}`}>
                    {summary.data.workItems[value]}
                  </dd>
                </div>
              ),
            )}
          </dl>
        </section>
      )}
      <section className="card filters" aria-label={t('development.developmentFilters')}>
        <SelectField
          label={t('development.filterByKind')}
          value={kind}
          options={[
            { value: '', label: t('development.anyKind') },
            ...DEVELOPMENT_ARTIFACT_KINDS.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setKind(event.target.value);
          }}
        />
        <SelectField
          label={t('development.filterByProvider')}
          value={provider}
          options={[
            { value: '', label: t('development.anyProvider') },
            ...DEVELOPMENT_PROVIDERS.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setProvider(event.target.value);
          }}
        />
        <SelectField
          label={t('development.filterByStatus')}
          value={status}
          options={[
            { value: '', label: t('development.anyStatus') },
            ...ALL_DEVELOPMENT_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setStatus(event.target.value);
          }}
        />
        <SelectField
          label={t('development.filterByWorkItem')}
          value={workItemId}
          options={[
            { value: '', label: t('development.anyWorkItem') },
            { value: 'none', label: t('development.notLinked') },
            ...items.map((entry) => ({ value: entry.id, label: `${entry.key} ${entry.title}` })),
          ]}
          onChange={(event) => {
            setWorkItemId(event.target.value);
          }}
        />
        <TextField
          label={t('development.searchDevelopment')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </section>

      {writable && (
        <form
          className="card form-grid"
          aria-label={t('development.recordDevelopmentActivity')}
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <h2>{t('development.recordDevelopmentActivity')}</h2>
          <SelectField
            label={t('development.artifactKind')}
            value={draft.kind}
            options={DEVELOPMENT_ARTIFACT_KINDS.map((value) => ({
              value,
              label: humanize(value),
            }))}
            onChange={(event) => {
              setDraft({
                ...draft,
                kind: event.target.value as DevelopmentArtifactKind,
                status: '',
              });
            }}
          />
          <TextField
            label={referenceLabel(draft.kind)}
            value={draft.reference}
            required
            {...(draft.kind === 'pull_request' ? { type: 'number', min: 1 } : {})}
            onChange={(event) => {
              setDraft({ ...draft, reference: event.target.value });
            }}
          />
          <TextField
            label={t('development.title')}
            value={draft.title}
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value });
            }}
          />
          {statusesFor(draft.kind).length > 0 && (
            <SelectField
              label={t('development.artifactStatus')}
              value={draft.status}
              options={[
                { value: '', label: t('development.noStatus') },
                ...statusesFor(draft.kind).map((value) => ({ value, label: humanize(value) })),
              ]}
              onChange={(event) => {
                setDraft({ ...draft, status: event.target.value });
              }}
            />
          )}
          {draft.kind === 'deployment' && (
            <TextField
              label={t('development.environment')}
              value={draft.environment}
              onChange={(event) => {
                setDraft({ ...draft, environment: event.target.value });
              }}
            />
          )}
          <TextField
            label={t('development.url')}
            type="url"
            value={draft.url}
            onChange={(event) => {
              setDraft({ ...draft, url: event.target.value });
            }}
          />
          <SelectField
            label={t('development.artifactProvider')}
            value={draft.provider}
            options={DEVELOPMENT_PROVIDERS.map((value) => ({ value, label: humanize(value) }))}
            onChange={(event) => {
              setDraft({ ...draft, provider: event.target.value as DevelopmentProvider });
            }}
          />
          <SelectField
            label={t('development.linkToWorkItem')}
            value={draft.workItemId}
            options={[
              { value: '', label: t('development.noWorkItem') },
              ...items.map((entry) => ({ value: entry.id, label: `${entry.key} ${entry.title}` })),
            ]}
            onChange={(event) => {
              setDraft({ ...draft, workItemId: event.target.value });
            }}
          />
          <Button type="submit" disabled={draft.reference.trim() === ''} loading={create.isPending}>
            {t('development.recordActivity')}
          </Button>
        </form>
      )}

      {notice !== null && <p role="status">{notice}</p>}
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <DataState
        isPending={artifacts.isPending}
        error={artifacts.error}
        isEmpty={rows.length === 0}
        emptyMessage={t('development.noDevelopmentActivityMatches')}
      >
        <table className="table card" aria-label={t('development.developmentActivity')}>
          <thead>
            <tr>
              <th scope="col">{t('development.artifact')}</th>
              <th scope="col">{t('development.provider')}</th>
              <th scope="col">{t('development.when')}</th>
              <th scope="col">{t('development.workItems')}</th>
              {manager && <th scope="col">{t('development.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <ArtifactSummary artifact={row} />
                  {row.environment !== null && <span className="muted"> · {row.environment}</span>}
                </td>
                <td>{humanize(row.provider)}</td>
                <td>{formatDateTime(row.occurredAt ?? row.createdAt)}</td>
                <td>
                  {row.workItems.length === 0 ? (
                    <span className="muted">{t('development.notLinked')}</span>
                  ) : (
                    row.workItems.map((entry) => (
                      <Link key={entry.linkId} to={`/work-items/${entry.workItemId}`}>
                        <Badge tone="info">{entry.key}</Badge>
                      </Link>
                    ))
                  )}
                </td>
                {manager && (
                  <td>
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t('development.delete', {
                        kind: row.kind,
                        value: artifactReference(row),
                      })}
                      onClick={() => {
                        remove.mutate(row.id);
                      }}
                    >
                      {t('development.delete2')}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {artifacts.data !== undefined && artifacts.data.meta.total > rows.length && (
          <p className="muted">
            {t('development.showing')} {rows.length} {t('development.of')}{' '}
            {artifacts.data.meta.total}
            {t('development.narrowTheFilters')}
          </p>
        )}
      </DataState>
    </>
  );
}
