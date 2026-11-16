import { RELEASE_TRANSITIONS } from '@qa-flow-hub/shared';
import type { ReleaseStatus } from '@qa-flow-hub/shared';
import { Badge, Button, DataState } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { buildsApi, releasesApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { BuildList } from './BuildsPage';
import { DeploymentsOf } from './DeploymentsPage';
import { RELEASE_TONE } from './ReleasesPage';
import { t } from '../i18n/i18n';

const ACTIONS: Array<{
  to: ReleaseStatus;
  action: 'start' | 'release' | 'archive';
  label: string;
}> = [
  {
    to: 'in_progress',
    action: 'start',
    get label() {
      return t('releaseDetail.startRelease');
    },
  },
  {
    to: 'released',
    action: 'release',
    get label() {
      return t('releaseDetail.markAsReleased');
    },
  },
  {
    to: 'archived',
    action: 'archive',
    get label() {
      return t('releaseDetail.archiveRelease');
    },
  },
];

function percent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

export function ReleaseDetailPage(): React.JSX.Element {
  const { releaseId = '' } = useParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ['releases', 'summary', releaseId],
    queryFn: () => releasesApi.summary(releaseId),
  });
  const trace = useQuery({
    queryKey: ['releases', 'traceability', releaseId],
    queryFn: () => releasesApi.traceability(releaseId),
  });
  const release = summary.data?.release;
  const { can } = useProjectPermissions(release?.projectId ?? null);

  const transition = useMutation({
    mutationFn: (action: 'start' | 'release' | 'archive') =>
      releasesApi.transition(releaseId, action),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError ? cause.message : t('releaseDetail.couldNotChangeTheRelease'),
      );
    },
  });

  return (
    <DataState isPending={summary.isPending} error={summary.error} isEmpty={false}>
      {release !== undefined && summary.data !== undefined && (
        <>
          <PageHeader
            title={`${release.name} · ${release.version}`}
            description={release.description ?? t('releaseDetail.runsResultsAndCoverageOf')}
          />
          <p>
            <Link to={`/releases/${release.id}/pipeline`}>
              {t('releaseDetail.releasePipeline')}
            </Link>
          </p>
          <p>
            <Badge tone={RELEASE_TONE[release.status]}>{humanize(release.status)}</Badge>{' '}
            {release.tag !== null && (
              <span>
                {t('releaseDetail.tag')} {release.tag} ·{' '}
              </span>
            )}
            <span>
              {release.startDate ?? '—'} → {release.targetDate ?? '—'}
            </span>
          </p>
          {error !== null && (
            <p className="ui-field__error" role="alert">
              {error}
            </p>
          )}
          {can('releases.manage') && (
            <div className="actions">
              {ACTIONS.filter((item) => RELEASE_TRANSITIONS[release.status].includes(item.to)).map(
                (item) => (
                  <Button
                    key={item.action}
                    variant={item.action === 'archive' ? 'secondary' : 'primary'}
                    loading={transition.isPending && transition.variables === item.action}
                    onClick={() => {
                      transition.mutate(item.action);
                    }}
                  >
                    {item.label}
                  </Button>
                ),
              )}
            </div>
          )}

          <section className="card" aria-labelledby="release-kpis">
            <h2 id="release-kpis">{t('releaseDetail.releaseHealth')}</h2>
            <dl className="kpis">
              <div>
                <dt>{t('releaseDetail.cases')}</dt>
                <dd>{summary.data.cases.total}</dd>
              </div>
              <div>
                <dt>{t('releaseDetail.passRate')}</dt>
                <dd>{percent(summary.data.cases.passRate)}</dd>
              </div>
              <div>
                <dt>{t('releaseDetail.failed')}</dt>
                <dd>{summary.data.cases.failed}</dd>
              </div>
              <div>
                <dt>{t('releaseDetail.requirementsPassing')}</dt>
                <dd>
                  {summary.data.requirements.passing} / {summary.data.requirements.total}
                </dd>
              </div>
              <div>
                <dt>{t('releaseDetail.openDefects')}</dt>
                <dd>{summary.data.defects.open}</dd>
              </div>
            </dl>
          </section>

          <section className="card" aria-labelledby="release-runs">
            <h2 id="release-runs">{t('releaseDetail.runs')}</h2>
            {summary.data.runs.length === 0 ? (
              <p>{t('releaseDetail.noRunInThisRelease')}</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t('releaseDetail.run')}</th>
                    <th scope="col">{t('releaseDetail.status')}</th>
                    <th scope="col">{t('releaseDetail.cases')}</th>
                    <th scope="col">{t('releaseDetail.passRate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.data.runs.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <Link to={`/test-runs/${run.id}`}>{run.name}</Link>
                      </td>
                      <td>
                        <Badge tone={toneFor(run.status)}>{humanize(run.status)}</Badge>
                      </td>
                      <td>{run.counts.total}</td>
                      <td>{percent(run.counts.passRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <ReleaseBuilds projectId={release.projectId} releaseId={release.id} />
          <DeploymentsOf projectId={release.projectId} filter={{ releaseId: release.id }} />

          <section className="card" aria-labelledby="release-trace">
            <h2 id="release-trace">{t('releaseDetail.traceability')}</h2>
            <DataState
              isPending={trace.isPending}
              error={trace.error}
              isEmpty={(trace.data?.rows.length ?? 0) === 0}
              emptyMessage={t('releaseDetail.noRequirementInThisProject')}
            >
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t('releaseDetail.requirement')}</th>
                    <th scope="col">{t('releaseDetail.casesAndLatestResultIn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.data?.rows.map((row) => (
                    <tr key={row.requirementId}>
                      <td>
                        {row.key} · {row.title}
                      </td>
                      <td>
                        {row.cases.length === 0
                          ? t('releaseDetail.noVerifyingCase')
                          : row.cases.map((item) => (
                              <span key={item.testCaseId} className="trace-chip">
                                {item.key}{' '}
                                <Badge tone={toneFor(item.status)}>{humanize(item.status)}</Badge>
                                {item.testRunName !== null && (
                                  <>
                                    {' '}
                                    {t('releaseDetail.in')} {item.testRunName}
                                  </>
                                )}{' '}
                              </span>
                            ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataState>
          </section>
        </>
      )}
    </DataState>
  );
}

/** Builds of the release (S5-F4). */
function ReleaseBuilds({
  projectId,
  releaseId,
}: {
  projectId: string;
  releaseId: string;
}): React.JSX.Element {
  const builds = useQuery({
    queryKey: ['builds', projectId, 'release', releaseId],
    queryFn: () => buildsApi.list({ projectId, releaseId }),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  return (
    <section className="card" aria-labelledby="release-builds">
      <h2 id="release-builds">{t('releaseDetail.builds')}</h2>
      {(builds.data?.data.length ?? 0) === 0 ? (
        <p>{t('releaseDetail.noBuildInThisRelease')}</p>
      ) : (
        <BuildList builds={builds.data?.data ?? []} label={t('releaseDetail.releaseBuilds')} />
      )}
    </section>
  );
}
