import { PIPELINE_STAGE_STATUSES } from '@qa-flow-hub/shared';
import type {
  PipelineDeploymentRef,
  PipelineStageStatus,
  PipelineStatus,
  QaResult,
  ReleasePipelineStage,
} from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { qualityGatesApi, releasesApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { GATE_TONE, QualityGateResults } from '../components/QualityGateResults';
import { APPROVAL_TONE, ReleaseApprovals } from '../components/ReleaseApprovals';
import { useProjectPermissions } from '../components/use-project-permissions';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';

const STAGE_TONE: Record<PipelineStageStatus, BadgeTone> = {
  pending: 'neutral',
  ready: 'warning',
  deploying: 'info',
  deployed: 'success',
  failed: 'danger',
  blocked: 'danger',
};

const PIPELINE_TONE: Record<PipelineStatus, BadgeTone> = {
  not_started: 'neutral',
  in_progress: 'info',
  deploying: 'info',
  failed: 'danger',
  blocked: 'danger',
  completed: 'success',
};

const QA_TONE: Record<QaResult, BadgeTone> = {
  none: 'neutral',
  in_progress: 'info',
  passed: 'success',
  failed: 'danger',
  blocked: 'warning',
};

function DeploymentLine({ deployment }: { deployment: PipelineDeploymentRef }): React.JSX.Element {
  const at = deployment.finishedAt ?? deployment.startedAt ?? deployment.createdAt;
  return (
    <>
      <Link to={`/deployments/${deployment.id}`}>{deployment.identifier}</Link> ·{' '}
      {humanize(deployment.status)}
      {deployment.rollback !== null && (
        <span data-testid={`rollback-${deployment.identifier ?? deployment.id}`}>
          {' · Rolled back from '}
          {deployment.rollback.from === null ? (
            'unknown'
          ) : (
            <Link to={`/deployments/${deployment.rollback.from.id}`}>
              {deployment.rollback.from.identifier}
            </Link>
          )}
          {' to '}
          {deployment.rollback.to === null ? (
            'an earlier build'
          ) : (
            <Link to={`/deployments/${deployment.rollback.to.id}`}>
              {deployment.rollback.to.identifier}
            </Link>
          )}
          {deployment.rollback.emergency && ' (emergency)'}
        </span>
      )}
      <br />
      <span className="muted">
        {new Date(at).toLocaleString()}
        {deployment.actor !== null && ` · ${deployment.actor.fullName}`}
      </span>
      {deployment.build !== null && (
        <>
          <br />
          Build <Link to={`/builds/${deployment.build.id}`}>{deployment.build.identifier}</Link>
          {deployment.commitSha !== null && (
            <>
              {' '}
              <code>{deployment.commitSha.slice(0, 7)}</code>
            </>
          )}
        </>
      )}
    </>
  );
}

function Stage({
  stage,
  index,
}: {
  stage: ReleasePipelineStage;
  index: number;
}): React.JSX.Element {
  return (
    <li
      className={`card pipeline-stage pipeline-stage--${stage.status}`}
      data-testid={`stage-${stage.environment.name}`}
      aria-label={`Stage ${index + 1}: ${stage.environment.name}, ${humanize(stage.status)}`}
    >
      <h3>
        <Link to={`/environments/${stage.environment.id}`}>{stage.environment.name}</Link>
      </h3>
      <p>
        <span data-testid={`stage-status-${stage.environment.name}`}>
          <Badge tone={STAGE_TONE[stage.status]}>{humanize(stage.status)}</Badge>
        </span>{' '}
        {stage.environment.protected && <Badge tone="warning">protected</Badge>}{' '}
        {stage.environment.status !== 'active' && (
          <Badge tone="neutral">{humanize(stage.environment.status)}</Badge>
        )}
      </p>
      {stage.rolledBack && <p className="muted">Rolled back</p>}
      {stage.blockers.length > 0 && (
        <ul aria-label={`Blockers of ${stage.environment.name}`}>
          {stage.blockers.map((blocker) => (
            <li key={blocker}>{humanize(blocker)}</li>
          ))}
        </ul>
      )}
      <p>
        {stage.lastDeployment === null ? (
          <span className="muted">Never deployed</span>
        ) : (
          <DeploymentLine deployment={stage.lastDeployment} />
        )}
      </p>
      <p>
        Gates:{' '}
        <span data-testid={`stage-gates-${stage.environment.name}`}>
          <Badge tone={GATE_TONE[stage.gates.result]}>{humanize(stage.gates.result)}</Badge>
        </span>
        {stage.gates.overridden && ' (overridden)'} · Approvals:{' '}
        <span data-testid={`stage-approvals-${stage.environment.name}`}>
          <Badge tone={APPROVAL_TONE[stage.approvals.state]}>
            {humanize(stage.approvals.state)}
          </Badge>
        </span>
      </p>
      <p className="muted">
        {stage.deploymentCount} deployment(s)
        {stage.environment.protected && !stage.canDeploy && ' · needs work item management'}
      </p>
      <p>
        QA:{' '}
        {stage.qa === null ? (
          <span className="muted">no run for this environment</span>
        ) : (
          <>
            <Link to={`/test-runs/${stage.qa.runId}`}>{stage.qa.name}</Link>{' '}
            <Badge tone={QA_TONE[stage.qa.result]}>{humanize(stage.qa.result)}</Badge>
          </>
        )}
      </p>
    </li>
  );
}

/** Gate results of the release for one environment, with the override form (S6-F3). */
function ReleaseGates({
  releaseId,
  projectId,
  environments,
}: {
  releaseId: string;
  projectId: string;
  environments: ReadonlyArray<{ id: string; name: string }>;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(projectId);
  const [environmentId, setEnvironmentId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const gates = useQuery({
    queryKey: ['release-gates', releaseId, environmentId],
    queryFn: () =>
      qualityGatesApi.evaluate(releaseId, environmentId === '' ? undefined : environmentId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const override = useMutation({
    mutationFn: () => qualityGatesApi.override(releaseId, environmentId, reason.trim()),
    onSuccess: async () => {
      setReason('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['release-gates'] });
      await queryClient.invalidateQueries({ queryKey: ['release-pipeline'] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not override the gates.');
    },
  });
  const view = gates.data;
  return (
    <section className="card" aria-labelledby="release-gates">
      <h2 id="release-gates">Quality gates</h2>
      <SelectField
        label="Gates for environment"
        value={environmentId}
        options={[
          { value: '', label: 'Project-wide gates only' },
          ...environments.map((env) => ({ value: env.id, label: env.name })),
        ]}
        onChange={(event) => {
          setEnvironmentId(event.target.value);
        }}
      />
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {view !== undefined && (
        <>
          <p>
            Required gates:{' '}
            <span data-testid="gates-required">
              <Badge tone={GATE_TONE[view.required.result]}>{humanize(view.required.result)}</Badge>
            </span>{' '}
            <span className="muted">
              {view.deployable ? 'deployment allowed' : 'deployment blocked if protected'}
            </span>
          </p>
          {view.override !== null && (
            <p data-testid="gates-override">
              Overridden by {view.override.createdBy?.fullName ?? 'someone'}: {view.override.reason}
            </p>
          )}
          <QualityGateResults view={view} />
          {environmentId !== '' && !view.deployable && can('quality_gates.override') && (
            <form
              aria-label="Override quality gates"
              onSubmit={(event) => {
                event.preventDefault();
                override.mutate();
              }}
            >
              <TextField
                label="Override reason"
                value={reason}
                required
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
              <Button type="submit" variant="secondary" disabled={override.isPending}>
                Override gates
              </Button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

/** Release pipeline (S6-F2): derived stages per environment, QA, defects and progress. */
export function ReleasePipelinePage(): React.JSX.Element {
  const { releaseId = '' } = useParams();
  const [environmentId, setEnvironmentId] = useState('');
  const [status, setStatus] = useState('');
  const pipeline = useQuery({
    queryKey: ['release-pipeline', releaseId, environmentId, status],
    queryFn: () =>
      releasesApi.pipeline(releaseId, {
        ...(environmentId === '' ? {} : { environmentId }),
        ...(status === '' ? {} : { status: status as PipelineStageStatus }),
      }),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const environments = useQuery({
    queryKey: ['release-pipeline', releaseId, 'all'],
    queryFn: () => releasesApi.pipeline(releaseId),
    staleTime: 0,
  });
  const view = pipeline.data;

  return (
    <DataState isPending={pipeline.isPending} error={pipeline.error} isEmpty={false}>
      {view !== undefined && (
        <>
          <PageHeader
            title={`Pipeline · ${view.release.name} ${view.release.version}`}
            description="Derived from deployments, builds, test runs and defects of the release."
          />
          <p>
            <Link to={`/releases/${view.release.id}`}>← Release</Link>
          </p>
          <section className="card" aria-labelledby="pipeline-summary">
            <h2 id="pipeline-summary">Summary</h2>
            <p>
              <span data-testid="pipeline-status">
                <Badge tone={PIPELINE_TONE[view.status]}>{humanize(view.status)}</Badge>
              </span>{' '}
              <span data-testid="pipeline-progress">
                {view.progress.deployed}/{view.progress.total} stages deployed (
                {view.progress.percent}%)
              </span>
            </p>
            <progress
              className="pipeline-progress"
              aria-label="Release progress"
              max={100}
              value={view.progress.percent}
            />
            <ul aria-label="Pipeline facts">
              <li>
                Build:{' '}
                {view.build === null ? (
                  'no passed build yet'
                ) : (
                  <Link to={`/builds/${view.build.id}`}>{view.build.identifier}</Link>
                )}
              </li>
              <li>
                QA: <Badge tone={QA_TONE[view.qa.result]}>{humanize(view.qa.result)}</Badge>{' '}
                <span className="muted">
                  {view.qa.counts.passed} passed · {view.qa.counts.failed} failed of{' '}
                  {view.qa.counts.total}
                </span>
              </li>
              <li>
                <Link to="/defects">Defects</Link>: {view.defects.open} open,{' '}
                {view.defects.blocking.length} blocking
              </li>
            </ul>
            {view.defects.blocking.length > 0 && (
              <ul aria-label="Blocking defects">
                {view.defects.blocking.map((defect) => (
                  <li key={defect.id}>
                    <Link to="/defects">
                      {defect.key} · {defect.title}
                    </Link>{' '}
                    <span className="muted">
                      {defect.severity} · {humanize(defect.status)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card filters" aria-label="Pipeline filters">
            <SelectField
              label="Stage environment"
              value={environmentId}
              options={[
                { value: '', label: 'All environments' },
                ...(environments.data?.stages ?? []).map((stage) => ({
                  value: stage.environment.id,
                  label: stage.environment.name,
                })),
              ]}
              onChange={(event) => {
                setEnvironmentId(event.target.value);
              }}
            />
            <SelectField
              label="Stage status"
              value={status}
              options={[
                { value: '', label: 'Any status' },
                ...PIPELINE_STAGE_STATUSES.map((value) => ({ value, label: humanize(value) })),
              ]}
              onChange={(event) => {
                setStatus(event.target.value);
              }}
            />
          </section>
          {view.stages.length === 0 ? (
            <p className="card">No stage matches. Add environments to build the pipeline.</p>
          ) : (
            <ol className="pipeline" aria-label="Pipeline stages">
              {view.stages.map((stage, index) => (
                <Stage key={stage.environment.id} stage={stage} index={index} />
              ))}
            </ol>
          )}
          <ReleaseApprovals
            releaseId={view.release.id}
            environments={(environments.data?.stages ?? []).map((stage) => stage.environment)}
          />
          <ReleaseGates
            releaseId={view.release.id}
            projectId={view.release.projectId}
            environments={(environments.data?.stages ?? []).map((stage) => stage.environment)}
          />
          {view.history.length > 0 && (
            <section className="card" aria-labelledby="pipeline-history">
              <h2 id="pipeline-history">Archived environments</h2>
              <ul aria-label="Archived environment history">
                {view.history.map((entry) => (
                  <li key={entry.environment.id}>
                    <Link to={`/environments/${entry.environment.id}`}>
                      {entry.environment.name}
                    </Link>{' '}
                    · {entry.deploymentCount} deployment(s)
                    {entry.lastDeployment !== null && (
                      <>
                        {' '}
                        · last{' '}
                        <Link to={`/deployments/${entry.lastDeployment.id}`}>
                          {entry.lastDeployment.identifier}
                        </Link>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </DataState>
  );
}
