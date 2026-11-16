import { APPROVAL_ACTIONS, APPROVAL_TYPE_LABELS, APPROVAL_TYPES } from '@qa-flow-hub/shared';
import type { ApprovalAction, ApprovalState, ApprovalType } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { releaseApprovalsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { humanize } from './status';
import { t } from '../i18n/i18n';

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
    setError(
      cause instanceof ApiError ? cause.message : t('c_releaseApprovals.couldNotRecordTheDecision'),
    );
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
      <h2 id="release-approvals">{t('c_releaseApprovals.approvals')}</h2>
      <SelectField
        label={t('c_releaseApprovals.approvalsForEnvironment')}
        value={environmentId}
        options={[
          { value: '', label: t('c_releaseApprovals.releaseWide') },
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
            {t('c_releaseApprovals.approvalState')}{' '}
            <span data-testid="approvals-state">
              <Badge tone={APPROVAL_TONE[view.state]}>{humanize(view.state)}</Badge>
            </span>
          </p>
          {view.requirements.length === 0 ? (
            <p className="muted">{t('c_releaseApprovals.noApprovalIsRequiredHere')}</p>
          ) : (
            <ul aria-label={t('c_releaseApprovals.approvalRequirements')}>
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
              aria-label={t('c_releaseApprovals.approvalDecision')}
              onSubmit={(event) => {
                event.preventDefault();
                decide.mutate();
              }}
            >
              <SelectField
                label={t('c_releaseApprovals.approveAs')}
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
                label={t('c_releaseApprovals.approvalAction')}
                value={action}
                options={APPROVAL_ACTIONS.map((value) => ({ value, label: humanize(value) }))}
                onChange={(event) => {
                  setAction(event.target.value as ApprovalAction);
                }}
              />
              <TextField
                label={t('c_releaseApprovals.decisionComment')}
                value={comment}
                required={action !== 'approve'}
                onChange={(event) => {
                  setComment(event.target.value);
                }}
              />
              {view.actions.selfApprovalBlocked.includes(type) && action === 'approve' && (
                <p className="muted">{t('c_releaseApprovals.youCreatedThisReleaseSo')}</p>
              )}
              <Button type="submit" disabled={decide.isPending}>
                {t('c_releaseApprovals.recordDecision')}
              </Button>
            </form>
          )}
          <h3>{t('c_releaseApprovals.history')}</h3>
          {view.history.length === 0 ? (
            <p className="muted">{t('c_releaseApprovals.noDecisionYet')}</p>
          ) : (
            <ul aria-label={t('c_releaseApprovals.approvalHistory')}>
              {view.history.map((entry) => (
                <li key={entry.id} data-testid={`approval-entry-${entry.id}`}>
                  {entry.approver?.fullName ?? t('c_releaseApprovals.someone')}{' '}
                  {humanize(entry.decision)} {t('c_releaseApprovals.as')}{' '}
                  {APPROVAL_TYPE_LABELS[entry.type]}
                  {entry.environment !== null && ` for ${entry.environment.name}`}
                  {entry.comment !== null && `: ${entry.comment}`}{' '}
                  <span className="muted">{new Date(entry.createdAt).toLocaleString()}</span>
                  {entry.revokedAt !== null ? (
                    <span className="muted">
                      {' '}
                      {t('c_releaseApprovals.revokedBy')}{' '}
                      {entry.revokedBy?.fullName ?? t('c_releaseApprovals.someone2')}
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
                          {t('c_releaseApprovals.revoke')}
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
