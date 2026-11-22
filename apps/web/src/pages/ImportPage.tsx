import { IMPORT_FORMATS } from '@qa-flow-hub/shared';
import type { ImportFormat, ImportIssue, ImportJobView } from '@qa-flow-hub/shared';
import { Badge, Button, DataState } from '@qa-flow-hub/ui';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { importsApi, testDesignApi } from '../api/endpoints';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';
import { formatDateTime, formatNumber } from '../i18n/format';

const FORMAT_LABELS: Record<ImportFormat, string> = {
  get qaflow_csv() {
    return t('import.qaFlowHubCsv');
  },
  get testrail_csv() {
    return t('import.testrailCsvExport');
  },
};

const STATUS_TONE: Record<ImportJobView['status'], BadgeTone> = {
  ready: 'success',
  invalid: 'danger',
  committed: 'info',
  expired: 'neutral',
};

const NEW_SUITE = '__new__';

/**
 * Import wizard: upload → dry run report → confirm. The dry run never writes
 * test cases; "Import" applies exactly the plan that was shown, and the API
 * refuses it if the project changed in between.
 */
export function ImportPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can, isPending: permissionsPending } = useProjectPermissions(activeProjectId);
  const [format, setFormat] = useState<ImportFormat>('qaflow_csv');
  const [suiteChoice, setSuiteChoice] = useState(NEW_SUITE);
  const [suiteName, setSuiteName] = useState(() => t('import.importedSuiteName'));
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const projectId = activeProjectId ?? '';
  const allowed = can('test_design.import');

  const suites = useQuery({
    queryKey: ['suites', activeProjectId],
    queryFn: () => testDesignApi.suites(projectId),
    enabled: activeProjectId !== null && allowed,
  });
  const limits = useQuery({
    queryKey: ['import-limits', activeProjectId],
    queryFn: () => importsApi.limits(projectId),
    enabled: activeProjectId !== null && allowed,
  });
  const history = useQuery({
    queryKey: ['imports', activeProjectId],
    queryFn: () => importsApi.list(projectId),
    enabled: activeProjectId !== null && allowed,
  });

  const dryRun = useMutation({
    mutationFn: (selected: File) =>
      importsApi.dryRun(
        projectId,
        suiteChoice === NEW_SUITE ? { format, suiteName } : { format, suiteId: suiteChoice },
        selected,
      ),
    onSuccess: async (result) => {
      setJob(result);
      setMessage(null);
      await queryClient.invalidateQueries({ queryKey: ['imports', activeProjectId] });
    },
  });

  const commit = useMutation({
    mutationFn: (id: string) => importsApi.commit(projectId, id),
    onSuccess: async (result) => {
      setJob(null);
      setFile(null);
      setMessage(
        t('import.importedSummary', {
          cases: result.created.cases,
          steps: result.created.steps,
          suites: result.created.suites,
          sections: result.created.sections,
          links: result.created.links,
        }),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['imports', activeProjectId] }),
        queryClient.invalidateQueries({ queryKey: ['suites'] }),
        queryClient.invalidateQueries({ queryKey: ['cases'] }),
        queryClient.invalidateQueries({ queryKey: ['matrix'] }),
      ]);
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  if (!permissionsPending && !allowed) {
    return (
      <>
        <PageHeader title={t('import.importTestCases')} />
        <p className="card">{t('import.youDoNotHavePermission')}</p>
      </>
    );
  }

  const errors = job?.summary.errors ?? 0;

  return (
    <>
      <PageHeader
        title={t('import.importTestCases')}
        description={t('import.uploadACsvReviewThe')}
      />

      {message !== null && (
        <p className="card" role="status">
          {message}
        </p>
      )}

      <form
        className="card form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (file !== null) {
            dryRun.mutate(file);
          }
        }}
      >
        <label className="ui-field">
          <span className="ui-field__label">{t('import.format')}</span>
          <select
            className="ui-input"
            value={format}
            onChange={(event) => {
              setFormat(event.target.value as ImportFormat);
            }}
          >
            {IMPORT_FORMATS.map((value) => (
              <option key={value} value={value}>
                {FORMAT_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="ui-field">
          <span className="ui-field__label">{t('import.targetSuite')}</span>
          <select
            className="ui-input"
            value={suiteChoice}
            onChange={(event) => {
              setSuiteChoice(event.target.value);
            }}
          >
            <option value={NEW_SUITE}>{t('import.newOrExistingSuiteBy')}</option>
            {suites.data?.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
              </option>
            ))}
          </select>
        </label>

        {suiteChoice === NEW_SUITE && (
          <label className="ui-field">
            <span className="ui-field__label">{t('import.suiteName')}</span>
            <input
              className="ui-input"
              value={suiteName}
              minLength={2}
              maxLength={120}
              required
              onChange={(event) => {
                setSuiteName(event.target.value);
              }}
            />
          </label>
        )}

        <label className="ui-field">
          <span className="ui-field__label">{t('import.csvFile')}</span>
          <input
            className="ui-input"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setJob(null);
            }}
          />
          {limits.data !== undefined && (
            <span className="ui-field__hint">
              {t('import.upTo')} {Math.round(limits.data.maxBytes / (1024 * 1024))}{' '}
              {t('import.mib')} {formatNumber(limits.data.maxRows)} {t('import.rowsAnd')}{' '}
              {formatNumber(limits.data.maxCases)} {t('import.casesUtf8CommaOr')}
            </span>
          )}
        </label>

        <div className="row-actions">
          <Button type="submit" disabled={file === null || dryRun.isPending}>
            {dryRun.isPending ? t('import.checking') : t('import.runDryRun')}
          </Button>
        </div>
        {dryRun.error !== null && (
          <p className="ui-field__error" role="alert">
            {dryRun.error.message}
          </p>
        )}
      </form>

      {job !== null && (
        <section className="card" aria-label={t('import.dryRunReport')}>
          <h2>
            {t('import.dryRun')}{' '}
            <Badge tone={STATUS_TONE[job.status]}>{humanize(job.status)}</Badge>
          </h2>
          <ImportSummaryLine job={job} />
          {errors > 0 && (
            <p className="ui-field__error">
              {t('import.fixThe')} {errors} {t('import.error')}
              {errors === 1 ? '' : 's'} {t('import.inTheFileAndRun')}
            </p>
          )}
          <IssueTable issues={job.issues ?? []} total={job.issueCount} />
          <div className="row-actions">
            <Button
              type="button"
              disabled={job.status !== 'ready' || commit.isPending}
              onClick={() => {
                commit.mutate(job.id);
              }}
            >
              {commit.isPending
                ? t('import.importing')
                : t('import.importTestCases2', { cases: job.summary.cases })}
            </Button>
          </div>
          {commit.error !== null && (
            <p className="ui-field__error" role="alert">
              {commit.error.message}
            </p>
          )}
        </section>
      )}

      <section className="card">
        <h2>{t('import.history')}</h2>
        <DataState
          isPending={history.isPending}
          error={history.error}
          isEmpty={(history.data?.length ?? 0) === 0}
          emptyMessage={t('import.noImportsYet')}
        >
          <table className="table table--compact" aria-label={t('import.importHistory')}>
            <thead>
              <tr>
                <th scope="col">{t('import.file')}</th>
                <th scope="col">{t('import.format')}</th>
                <th scope="col">{t('import.status')}</th>
                <th scope="col">{t('import.cases')}</th>
                <th scope="col">{t('import.issues')}</th>
                <th scope="col">{t('import.created')}</th>
              </tr>
            </thead>
            <tbody>
              {history.data?.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.fileName}</td>
                  <td>{FORMAT_LABELS[entry.format]}</td>
                  <td>
                    <Badge tone={STATUS_TONE[entry.status]}>{humanize(entry.status)}</Badge>
                  </td>
                  <td>{entry.summary.cases}</td>
                  <td>{entry.issueCount}</td>
                  <td>{formatDateTime(entry.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataState>
      </section>
    </>
  );
}

function ImportSummaryLine({ job }: { job: ImportJobView }): React.JSX.Element {
  const { summary } = job;
  return (
    <p>
      {summary.rows} {t('import.rows')} {summary.cases} {t('import.newCases')} {summary.steps}{' '}
      {t('import.steps')} {summary.newSuites} {t('import.newSuites')} {summary.newSections}{' '}
      {t('import.newSections')} {summary.links} {t('import.requirementLinks')} {summary.duplicates}{' '}
      {t('import.duplicatesSkipped')} {summary.errors} {t('import.errors')} {summary.warnings}{' '}
      {t('import.warnings')}
    </p>
  );
}

function IssueTable({
  issues,
  total,
}: {
  issues: ImportIssue[];
  total: number;
}): React.JSX.Element | null {
  if (issues.length === 0) {
    return null;
  }
  return (
    <div className="table-scroll">
      {total > issues.length && (
        <p className="muted">
          {t('import.showingTheFirst')} {issues.length} {t('import.of')} {total}{' '}
          {t('import.issues2')}
        </p>
      )}
      <table className="table table--compact" aria-label={t('import.importIssues')}>
        <thead>
          <tr>
            <th scope="col">{t('import.row')}</th>
            <th scope="col">{t('import.column')}</th>
            <th scope="col">{t('import.severity')}</th>
            <th scope="col">{t('import.code')}</th>
            <th scope="col">{t('import.message')}</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, index) => (
            <tr key={`${issue.row}-${issue.code}-${index}`}>
              <td>{issue.row}</td>
              <td>{issue.column ?? '—'}</td>
              <td>
                <Badge tone={issue.severity === 'error' ? 'danger' : 'warning'}>
                  {humanize(issue.severity)}
                </Badge>
              </td>
              <td>
                <code>{issue.code}</code>
              </td>
              <td>{issue.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
