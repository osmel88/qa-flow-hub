import { APPROVAL_ACTIONS, APPROVAL_TYPE_LABELS, APPROVAL_TYPES } from '@qa-flow-hub/shared';
import type { ApprovalAction, ApprovalState, ApprovalType } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { releaseApprovalsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { humanize } from './status';

export const APPROVAL_TONE: Record<ApprovalState, BadgeTone> = {
  approved: 'success',
  rejected: 'danger',
  changes_requested: 'warning',
  pending: 'neutral',
};

/** Approval requirements, state, history and actions of a release (S6-F4). */
export function ReleaseApprovals({
  releaseId,
  environments,
}: {
  releaseId: string;
  environments: ReadonlyArray<{ id: string; name: string }>;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [environmentId, setEnvironmentId] = useState('');
  const [type, setType] = useState<ApprovalType>('qa');
  const [action, setAction] = useState<ApprovalAction>('approve');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const approvals = useQuery({
    queryKey: ['release-approvals', releaseId, environmentId],
    queryFn: () =>
      releaseApprovalsApi.view(releaseId, environmentId === '' ? undefined : environmentId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const done = async () => {
    setComment('');
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['release-approvals'] });
    await queryClient.invalidateQueries({ queryKey: ['release-pipeline'] });
  };
  const onError = async (cause: unknown) => {
    setError(cause instanceof ApiError ? cause.message : 'Could not record the decision.');
    await queryClient.invalidateQueries({ queryKey: ['release-approvals'] });
  };
  const decide = useMutation({
    mutationFn: () =>
      releaseApprovalsApi.decide(releaseId, {
        type,
        action,
        ...(environmentId === '' ? {} : { environmentId }),
        ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
      }),
    onSuccess: done,
    onError,
  });
  const revoke = useMutation({
    mutationFn: (approvalId: string) => releaseApprovalsApi.revoke(releaseId, approvalId),
    onSuccess: done,
    onError,
  });
  const view = approvals.data;
  return (
    <section className="card" aria-labelledby="release-approvals">
      <h2 id="release-approvals">Approvals</h2>
      <SelectField
        label="Approvals for environment"
        value={environmentId}
        options={[
          { value: '', label: 'Release-wide' },
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
            Approval state:{' '}
            <span data-testid="approvals-state">
              <Badge tone={APPROVAL_TONE[view.state]}>{humanize(view.state)}</Badge>
            </span>
          </p>
          {view.requirements.length === 0 ? (
            <p className="muted">No approval is required here.</p>
          ) : (
            <ul aria-label="Approval requirements">
              {view.requirements.map((requirement) => (
                <li key={requirement.type} data-testid={`approval-${requirement.type}`}>
                  {APPROVAL_TYPE_LABELS[requirement.type]}: {requirement.approvals}/
                  {requirement.requiredApprovals}{' '}
                  <Badge tone={APPROVAL_TONE[requirement.state]}>
                    {humanize(requirement.state)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {view.actions.decide && (
            <form
              aria-label="Approval decision"
              onSubmit={(event) => {
                event.preventDefault();
                decide.mutate();
              }}
            >
              <SelectField
                label="Approve as"
                value={type}
                options={APPROVAL_TYPES.map((value) => ({
                  value,
                  label: APPROVAL_TYPE_LABELS[value],
                }))}
                onChange={(event) => {
                  setType(event.target.value as ApprovalType);
                }}
              />
              <SelectField
                label="Approval action"
                value={action}
                options={APPROVAL_ACTIONS.map((value) => ({ value, label: humanize(value) }))}
                onChange={(event) => {
                  setAction(event.target.value as ApprovalAction);
                }}
              />
              <TextField
                label="Decision comment"
                value={comment}
                required={action !== 'approve'}
                onChange={(event) => {
                  setComment(event.target.value);
                }}
              />
              {view.actions.selfApprovalBlocked.includes(type) && action === 'approve' && (
                <p className="muted">You created this release, so you cannot give this approval.</p>
              )}
              <Button type="submit" disabled={decide.isPending}>
                Record decision
              </Button>
            </form>
          )}
          <h3>History</h3>
          {view.history.length === 0 ? (
            <p className="muted">No decision yet.</p>
          ) : (
            <ul aria-label="Approval history">
              {view.history.map((entry) => (
                <li key={entry.id} data-testid={`approval-entry-${entry.id}`}>
                  {entry.approver?.fullName ?? 'Someone'} {humanize(entry.decision)} as{' '}
                  {APPROVAL_TYPE_LABELS[entry.type]}
                  {entry.environment !== null && ` for ${entry.environment.name}`}
                  {entry.comment !== null && `: ${entry.comment}`}{' '}
                  <span className="muted">{new Date(entry.createdAt).toLocaleString()}</span>
                  {entry.revokedAt !== null ? (
                    <span className="muted">
                      {' '}
                      · revoked by {entry.revokedBy?.fullName ?? 'someone'}
                    </span>
                  ) : (
                    view.actions.decide && (
                      <>
                        {' '}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            revoke.mutate(entry.id);
                          }}
                        >
                          Revoke
                        </Button>
                      </>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
