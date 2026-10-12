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

const FORMAT_LABELS: Record<ImportFormat, string> = {
  qaflow_csv: 'qa-flow-hub CSV',
  testrail_csv: 'TestRail CSV export',
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
  const [suiteName, setSuiteName] = useState('Imported');
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
        `Imported ${result.created.cases} test cases with ${result.created.steps} steps ` +
          `(${result.created.suites} new suites, ${result.created.sections} new sections, ` +
          `${result.created.links} requirement links).`,
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
        <PageHeader title="Import test cases" />
        <p className="card">You do not have permission to import test cases in this project.</p>
      </>
    );
  }

  const errors = job?.summary.errors ?? 0;

  return (
    <>
      <PageHeader
        title="Import test cases"
        description="Upload a CSV, review the dry run, then confirm. Nothing is created until you confirm."
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
          <span className="ui-field__label">Format</span>
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
          <span className="ui-field__label">Target suite</span>
          <select
            className="ui-input"
            value={suiteChoice}
            onChange={(event) => {
              setSuiteChoice(event.target.value);
            }}
          >
            <option value={NEW_SUITE}>New or existing suite by name…</option>
            {suites.data?.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
              </option>
            ))}
          </select>
        </label>

        {suiteChoice === NEW_SUITE && (
          <label className="ui-field">
            <span className="ui-field__label">Suite name</span>
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
          <span className="ui-field__label">CSV file</span>
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
              Up to {Math.round(limits.data.maxBytes / (1024 * 1024))} MiB,{' '}
              {limits.data.maxRows.toLocaleString()} rows and{' '}
              {limits.data.maxCases.toLocaleString()} cases. UTF-8, comma or semicolon separated.
            </span>
          )}
        </label>

        <div className="row-actions">
          <Button type="submit" disabled={file === null || dryRun.isPending}>
            {dryRun.isPending ? 'Checking…' : 'Run dry run'}
          </Button>
        </div>
        {dryRun.error !== null && (
          <p className="ui-field__error" role="alert">
            {dryRun.error.message}
          </p>
        )}
      </form>

      {job !== null && (
        <section className="card" aria-label="Dry run report">
          <h2>
            Dry run <Badge tone={STATUS_TONE[job.status]}>{humanize(job.status)}</Badge>
          </h2>
          <ImportSummaryLine job={job} />
          {errors > 0 && (
            <p className="ui-field__error">
              Fix the {errors} error{errors === 1 ? '' : 's'} in the file and run the dry run again.
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
              {commit.isPending ? 'Importing…' : `Import ${job.summary.cases} test cases`}
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
        <h2>History</h2>
        <DataState
          isPending={history.isPending}
          error={history.error}
          isEmpty={(history.data?.length ?? 0) === 0}
          emptyMessage="No imports yet."
        >
          <table className="table table--compact" aria-label="Import history">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Format</th>
                <th scope="col">Status</th>
                <th scope="col">Cases</th>
                <th scope="col">Issues</th>
                <th scope="col">Created</th>
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
                  <td>{new Date(entry.createdAt).toLocaleString()}</td>
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
      {summary.rows} rows: {summary.cases} new cases, {summary.steps} steps, {summary.newSuites} new
      suites, {summary.newSections} new sections, {summary.links} requirement links.{' '}
      {summary.duplicates} duplicates skipped, {summary.errors} errors, {summary.warnings} warnings.
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
          Showing the first {issues.length} of {total} issues.
        </p>
      )}
      <table className="table table--compact" aria-label="Import issues">
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Column</th>
            <th scope="col">Severity</th>
            <th scope="col">Code</th>
            <th scope="col">Message</th>
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
