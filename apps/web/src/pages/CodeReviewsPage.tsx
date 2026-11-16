import { CODE_REVIEW_STATUSES } from '@qa-flow-hub/shared';
import type { CodeReviewStatus, CodeReviewSummaryView, MergeReadiness } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { codeReviewsApi, developmentApi, organizationsApi, workItemsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';

export const CODE_REVIEW_TONE: Record<CodeReviewStatus, BadgeTone> = {
  pending: 'neutral',
  in_review: 'info',
  changes_requested: 'danger',
  approved: 'success',
  dismissed: 'neutral',
};

export function ReadinessBadge({ readiness }: { readiness: MergeReadiness }): React.JSX.Element {
  return (
    <span data-testid="merge-readiness" title={readiness.blockers.map(humanize).join(', ')}>
      <Badge tone={readiness.ready ? 'success' : 'warning'}>
        {readiness.ready
          ? t('codeReviews.readyToMerge')
          : t('codeReviews.notReadyApprovals', {
              approvals: readiness.approvals,
              requiredApprovals: readiness.requiredApprovals,
            })}
      </Badge>
    </span>
  );
}

export function CodeReviewRow({ review }: { review: CodeReviewSummaryView }): React.JSX.Element {
  return (
    <>
      <Link to={`/code-reviews/${review.id}`}>{review.title}</Link>{' '}
      <Badge tone={CODE_REVIEW_TONE[review.status]}>{humanize(review.status)}</Badge>{' '}
      <ReadinessBadge readiness={review.mergeReadiness} />
    </>
  );
}

/** Code reviews of the project (S5-F3): list, filters and a form to open one. */
export function CodeReviewsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { can } = useProjectPermissions(activeProjectId);
  const writable = can('work_items.write');
  const projectId = activeProjectId ?? '';
  const [status, setStatus] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [author, setAuthor] = useState('');
  const [title, setTitle] = useState('');
  const [reviewerId, setReviewerId] = useState('');
  const [pullRequestId, setPullRequestId] = useState('');
  const [workItemId, setWorkItemId] = useState('');
  const [approvals, setApprovals] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reviews = useQuery({
    queryKey: ['code-reviews', activeProjectId, status, reviewer, author],
    queryFn: () =>
      codeReviewsApi.list({
        projectId,
        ...(status === '' ? {} : { status: status as CodeReviewStatus }),
        ...(reviewer === '' ? {} : { reviewerId: reviewer }),
        ...(author === '' ? {} : { authorId: author }),
      }),
    enabled: activeProjectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const members = useQuery({
    queryKey: ['organization-members'],
    queryFn: () => organizationsApi.members(),
    enabled: activeProjectId !== null,
  });
  const pullRequests = useQuery({
    queryKey: ['development', activeProjectId, 'pull-requests'],
    queryFn: () => developmentApi.list({ projectId, kind: 'pull_request' }),
    enabled: activeProjectId !== null && writable,
  });
  const workItems = useQuery({
    queryKey: ['work-items', activeProjectId, 'code-review-options'],
    queryFn: () => workItemsApi.list({ projectId }),
    enabled: activeProjectId !== null && writable,
  });
  const create = useMutation({
    mutationFn: () =>
      codeReviewsApi.create({
        projectId,
        title,
        reviewerIds: reviewerId === '' ? [] : [reviewerId],
        workItemIds: workItemId === '' ? [] : [workItemId],
        ...(pullRequestId === '' ? {} : { pullRequestId }),
        ...(approvals === '' ? {} : { requiredApprovals: Number(approvals) }),
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['code-reviews'] });
      void navigate(`/code-reviews/${created.id}`);
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t('codeReviews.couldNotOpenTheReview'));
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }
  const memberOptions = (members.data?.data ?? []).map((member) => ({
    value: member.userId,
    label: member.fullName,
  }));
  const userFilter = [
    { value: '', label: t('codeReviews.anyone') },
    { value: 'me', label: t('codeReviews.me') },
    ...memberOptions,
  ];

  return (
    <>
      <PageHeader
        title={t('codeReviews.codeReviews')}
        description={t('codeReviews.localCodeReviewsReviewersApprovals')}
      />
      <section className="card filters" aria-label={t('codeReviews.codeReviewFilters')}>
        <SelectField
          label={t('codeReviews.statusFilter')}
          value={status}
          options={[
            { value: '', label: t('codeReviews.anyStatus') },
            ...CODE_REVIEW_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setStatus(event.target.value);
          }}
        />
        <SelectField
          label={t('codeReviews.reviewerFilter')}
          value={reviewer}
          options={userFilter}
          onChange={(event) => {
            setReviewer(event.target.value);
          }}
        />
        <SelectField
          label={t('codeReviews.authorFilter')}
          value={author}
          options={userFilter}
          onChange={(event) => {
            setAuthor(event.target.value);
          }}
        />
      </section>
      {writable && (
        <form
          className="card"
          aria-label={t('codeReviews.openACodeReview')}
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <h2>{t('codeReviews.openACodeReview')}</h2>
          <TextField
            label={t('codeReviews.reviewTitle')}
            value={title}
            required
            minLength={3}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <SelectField
            label={t('codeReviews.reviewer')}
            value={reviewerId}
            options={[{ value: '', label: t('codeReviews.noReviewerYet') }, ...memberOptions]}
            onChange={(event) => {
              setReviewerId(event.target.value);
            }}
          />
          <SelectField
            label={t('codeReviews.pullRequest')}
            value={pullRequestId}
            options={[
              { value: '', label: t('codeReviews.noPullRequest') },
              ...(pullRequests.data?.data ?? []).map((pr) => ({
                value: pr.id,
                label: `#${pr.prNumber ?? ''} ${pr.title ?? ''}`.trim(),
              })),
            ]}
            onChange={(event) => {
              setPullRequestId(event.target.value);
            }}
          />
          <SelectField
            label={t('codeReviews.workItem')}
            value={workItemId}
            options={[
              { value: '', label: t('codeReviews.noWorkItem') },
              ...(workItems.data?.data ?? []).map((item) => ({
                value: item.id,
                label: `${item.key} · ${item.title}`,
              })),
            ]}
            onChange={(event) => {
              setWorkItemId(event.target.value);
            }}
          />
          <TextField
            label={t('codeReviews.requiredApprovalsEmptyProjectRule')}
            type="number"
            min={1}
            max={20}
            value={approvals}
            onChange={(event) => {
              setApprovals(event.target.value);
            }}
          />
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={create.isPending}>
            {t('codeReviews.openReview')}
          </Button>
        </form>
      )}
      <DataState
        isPending={reviews.isPending}
        error={reviews.error}
        isEmpty={(reviews.data?.data.length ?? 0) === 0}
        emptyMessage={t('codeReviews.noCodeReviewsMatch')}
      >
        <ul className="card" aria-label={t('codeReviews.codeReviews')}>
          {(reviews.data?.data ?? []).map((review) => (
            <li key={review.id} data-testid={`code-review-${review.id}`}>
              <CodeReviewRow review={review} />{' '}
              <span className="muted">
                {t('codeReviews.by')} {review.author.fullName} {t('codeReviews.reviewers')}{' '}
                {review.reviewers.length === 0
                  ? t('codeReviews.none')
                  : review.reviewers
                      .map((entry) => `${entry.user.fullName} (${humanize(entry.decision)})`)
                      .join(', ')}
              </span>
            </li>
          ))}
        </ul>
      </DataState>
    </>
  );
}
