import type {
  ExternalReferenceView,
  ImportAutomatedResultsView,
  ListGitHubReferencesQuery,
} from '@qa-flow-hub/shared';
import { Badge, Button, SelectField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { gitHubApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { humanize, toneFor } from './status';

/**
 * One query for the whole screen: the GitHub references of every run in the
 * project, or of every result in a run. Each cell picks its own by entity id.
 */
export function useGitHubReferences(query: ListGitHubReferencesQuery, enabled = true) {
  return useQuery({
    queryKey: ['github-references', query],
    queryFn: () => gitHubApi.references(query),
    enabled,
    select: (references): Map<string, ExternalReferenceView> =>
      new Map(references.map((reference) => [reference.entityId, reference])),
  });
}

/** Status/conclusion of a workflow run as one badge: "success", "failure", "in progress". */
export function WorkflowRunBadge({
  reference,
}: {
  reference: ExternalReferenceView;
}): React.JSX.Element {
  const conclusion = reference.metadata['conclusion'] ?? '';
  const status = reference.metadata['status'] ?? 'unknown';
  const label = conclusion === '' ? status : conclusion;
  return <Badge tone={WORKFLOW_TONES[label] ?? toneFor(label)}>{humanize(label)}</Badge>;
}

const WORKFLOW_TONES: Record<string, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = {
  success: 'success',
  failure: 'danger',
  cancelled: 'neutral',
  timed_out: 'danger',
  action_required: 'warning',
  in_progress: 'info',
  queued: 'info',
  requested: 'info',
  waiting: 'info',
};

/** The compact, read-only form for the runs table: linked run key and outcome. */
export function GitHubRunCell({
  reference,
}: {
  reference: ExternalReferenceView | undefined;
}): React.JSX.Element {
  if (reference === undefined) {
    return <span className="muted">—</span>;
  }
  const label = reference.externalKey ?? reference.externalId;
  return (
    <div className="external-sync">
      {reference.externalUrl === null ? (
        <code>{label}</code>
      ) : (
        <a href={reference.externalUrl} target="_blank" rel="noreferrer">
          <code>{label}</code>
        </a>
      )}
      <WorkflowRunBadge reference={reference} />
    </div>
  );
}

interface GitHubRunPanelProps {
  testRunId: string;
  runStatus: string;
  reference: ExternalReferenceView | undefined;
  onImported: () => Promise<unknown>;
}

/**
 * The GitHub side of the execution screen: which workflow run this test run
 * mirrors, and the button that brings its Playwright results in as
 * `TestResult` rows. The picker lists repositories then runs and never leaves
 * the page: linking CI is part of running the suite, not a settings task.
 */
export function GitHubRunPanel({
  testRunId,
  runStatus,
  reference,
  onImported,
}: GitHubRunPanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportAutomatedResultsView | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['github-references'] });

  const refresh = useMutation({
    mutationFn: () => gitHubApi.linkRun(testRunId, null),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not refresh the workflow run.');
    },
  });

  const importResults = useMutation({
    mutationFn: () => gitHubApi.importResults(testRunId),
    onSuccess: async (result) => {
      setError(null);
      setReport(result);
      await Promise.all([invalidate(), onImported()]);
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not import the results.');
    },
  });

  const closed = runStatus === 'completed' || runStatus === 'aborted';

  return (
    <section className="card" aria-label="GitHub workflow run">
      <div className="external-sync">
        <strong>GitHub</strong>
        {reference === undefined ? (
          <span className="muted">No workflow run linked.</span>
        ) : (
          <>
            <GitHubRunCell reference={reference} />
            <span className="muted">
              {reference.metadata['workflowName']} · {reference.metadata['headBranch']} @{' '}
              <code>{reference.metadata['headSha']?.slice(0, 7)}</code>
            </span>
          </>
        )}
      </div>
      <div className="row-actions">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setPicking((open) => !open);
          }}
        >
          {reference === undefined ? 'Link workflow run' : 'Re-link'}
        </Button>
        {reference !== undefined && (
          <>
            <Button
              size="sm"
              variant="secondary"
              loading={refresh.isPending}
              onClick={() => {
                refresh.mutate();
              }}
            >
              Refresh status
            </Button>
            <Button
              size="sm"
              disabled={closed}
              loading={importResults.isPending}
              onClick={() => {
                importResults.mutate();
              }}
            >
              Import results
            </Button>
          </>
        )}
      </div>
      {picking && (
        <WorkflowRunPicker
          testRunId={testRunId}
          onLinked={async () => {
            setPicking(false);
            setError(null);
            setReport(null);
            await invalidate();
          }}
          onError={setError}
        />
      )}
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {report !== null && <ImportReport report={report} />}
    </section>
  );
}

interface WorkflowRunPickerProps {
  testRunId: string;
  onLinked: () => Promise<void>;
  onError: (message: string) => void;
}

function WorkflowRunPicker({
  testRunId,
  onLinked,
  onError,
}: WorkflowRunPickerProps): React.JSX.Element {
  const [repositoryExternalId, setRepository] = useState('');
  const [runExternalId, setRun] = useState('');

  const repositories = useQuery({
    queryKey: ['github-repositories'],
    queryFn: gitHubApi.repositories,
  });
  const runs = useQuery({
    queryKey: ['github-workflow-runs', repositoryExternalId],
    queryFn: () => gitHubApi.workflowRuns({ repositoryExternalId }),
    enabled: repositoryExternalId !== '',
  });

  const link = useMutation({
    mutationFn: () => gitHubApi.linkRun(testRunId, { repositoryExternalId, runExternalId }),
    onSuccess: onLinked,
    onError: (cause) => {
      onError(cause instanceof ApiError ? cause.message : 'Could not link the workflow run.');
    },
  });

  const loadError = repositories.error ?? runs.error;

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        link.mutate();
      }}
    >
      <SelectField
        label="Repository"
        value={repositoryExternalId}
        onChange={(event) => {
          setRepository(event.target.value);
          setRun('');
        }}
        options={[
          { value: '', label: repositories.isPending ? 'Loading…' : 'Choose a repository' },
          ...(repositories.data ?? []).map((repository) => ({
            value: repository.externalId,
            label: repository.fullName,
          })),
        ]}
      />
      <SelectField
        label="Workflow run"
        value={runExternalId}
        disabled={repositoryExternalId === ''}
        onChange={(event) => {
          setRun(event.target.value);
        }}
        options={[
          { value: '', label: runs.isPending && runs.isFetching ? 'Loading…' : 'Choose a run' },
          ...(runs.data ?? []).map((run) => ({
            value: run.externalId,
            label: `#${run.runNumber} ${run.workflowName} · ${run.headBranch} · ${
              run.conclusion ?? run.status
            }`,
          })),
        ]}
      />
      {loadError !== null && loadError !== undefined && (
        <p className="ui-field__error" role="alert">
          {loadError instanceof ApiError ? loadError.message : 'Could not reach GitHub.'}
        </p>
      )}
      <div className="row-actions">
        <Button size="sm" type="submit" disabled={runExternalId === ''} loading={link.isPending}>
          Link
        </Button>
      </div>
    </form>
  );
}

const SKIP_REASONS: Record<ImportAutomatedResultsView['skipped'][number]['reason'], string> = {
  no_case_tag: 'no @C-n tag in the title',
  case_not_in_run: 'case is not part of this run',
  run_not_completed: 'the workflow run has not finished',
  already_imported: 'already imported',
};

function ImportReport({ report }: { report: ImportAutomatedResultsView }): React.JSX.Element {
  return (
    <div role="status" className="stack">
      <p>
        Imported {report.imported.length} result{report.imported.length === 1 ? '' : 's'}
        {report.skipped.length > 0 && `, skipped ${report.skipped.length}`}.
      </p>
      {report.skipped.length > 0 && (
        <ul className="plain-list muted">
          {report.skipped.map((skip) => (
            <li key={skip.externalId}>
              <code>{skip.testIdentifier}</code> — {SKIP_REASONS[skip.reason]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shown under a result that came from CI: which automated test produced it. */
export function GitHubResultOrigin({
  reference,
}: {
  reference: ExternalReferenceView | undefined;
}): React.JSX.Element | null {
  if (reference === undefined) {
    return null;
  }
  const label = `${reference.metadata['framework'] ?? 'automation'} · ${
    reference.externalKey ?? reference.externalId
  }`;
  return (
    <span className="muted">
      From GitHub:{' '}
      {reference.externalUrl === null ? (
        <code>{label}</code>
      ) : (
        <a href={reference.externalUrl} target="_blank" rel="noreferrer">
          <code>{label}</code>
        </a>
      )}
    </span>
  );
}
