import { Badge, Button, DataState, SelectField, TextAreaField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { codeReviewsApi, organizationsApi, workItemsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { CODE_REVIEW_TONE, ReadinessBadge } from './CodeReviewsPage';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';

/** A code review: decisions, reviewers, work items and history (S5-F3). */
export function CodeReviewDetailPage(): React.JSX.Element {
  const { reviewId = '' } = useParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [newReviewer, setNewReviewer] = useState('');
  const [newWorkItem, setNewWorkItem] = useState('');
  const [error, setError] = useState<string | null>(null);
  const review = useQuery({
    queryKey: ['code-review', reviewId],
    queryFn: () => codeReviewsApi.get(reviewId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const projectId = review.data?.projectId ?? null;
  const { can } = useProjectPermissions(projectId);
  const writable = can('work_items.write');
  const manager = can('work_items.manage');
  const members = useQuery({
    queryKey: ['organization-members'],
    queryFn: () => organizationsApi.members(),
    enabled: writable,
  });
  const workItems = useQuery({
    queryKey: ['work-items', projectId, 'code-review-options'],
    queryFn: () => workItemsApi.list({ projectId: projectId ?? '' }),
    enabled: writable && projectId !== null,
  });
  const act = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      setError(null);
      setComment('');
      setNewReviewer('');
      setNewWorkItem('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['code-review', reviewId] }),
        queryClient.invalidateQueries({ queryKey: ['code-reviews'] }),
        queryClient.invalidateQueries({ queryKey: ['development'] }),
      ]);
    },
    onError: (cause: unknown) => {
      setError(
        cause instanceof ApiError ? cause.message : t('codeReviewDetail.couldNotUpdateTheReview'),
      );
    },
  });

  const data = review.data;
  const open = data !== undefined && data.status !== 'dismissed';
  const mine = data?.reviewers.find((entry) => entry.user.id === user?.id);
  const canDecide = open && mine !== undefined && can('code_reviews.review');
  const note = comment.trim() === '' ? {} : { comment: comment.trim() };

  return (
    <DataState isPending={review.isPending} error={review.error} isEmpty={false}>
      {data !== undefined && (
        <>
          <PageHeader title={data.title} description={t('codeReviewDetail.codeReviewDetail')} />
          <p>
            <Link to="/code-reviews">{t('codeReviewDetail.allCodeReviews')}</Link>
          </p>
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <section className="card" aria-labelledby="review-summary">
            <h2 id="review-summary">{t('codeReviewDetail.summary')}</h2>
            <p>
              <span data-testid="review-status">
                <Badge tone={CODE_REVIEW_TONE[data.status]}>{humanize(data.status)}</Badge>
              </span>{' '}
              <ReadinessBadge readiness={data.mergeReadiness} />
            </p>
            {data.mergeReadiness.blockers.length > 0 && (
              <p className="muted" data-testid="merge-blockers">
                {t('codeReviewDetail.blockedBy')}{' '}
                {data.mergeReadiness.blockers.map(humanize).join(', ')}
              </p>
            )}
            <p>
              {t('codeReviewDetail.author')} {data.author.fullName}
              {data.pullRequest !== null && (
                <>
                  {' '}
                  {t('codeReviewDetail.pullRequest')}{' '}
                  <Link to={`/development?kind=pull_request`}>
                    #{data.pullRequest.prNumber} {data.pullRequest.title ?? ''}
                  </Link>{' '}
                  ({humanize(data.pullRequest.status ?? 'open')})
                </>
              )}
            </p>
            {data.summary !== null && <p>{data.summary}</p>}
            {manager && open && (
              <Button
                variant="secondary"
                onClick={() => {
                  act.mutate(() => codeReviewsApi.dismiss(data.id));
                }}
              >
                {t('codeReviewDetail.dismissReview')}
              </Button>
            )}
          </section>

          <section className="card" aria-labelledby="review-reviewers">
            <h2 id="review-reviewers">{t('codeReviewDetail.reviewers')}</h2>
            <ul aria-label={t('codeReviewDetail.reviewers')}>
              {data.reviewers.map((entry) => (
                <li key={entry.user.id} data-testid={`reviewer-${entry.user.fullName}`}>
                  {entry.user.fullName}: <strong>{humanize(entry.decision)}</strong>
                  {!entry.canReview && (
                    <span className="muted"> {t('codeReviewDetail.cannotReviewAnyMore')}</span>
                  )}
                  {entry.comment !== null && <span className="muted"> — {entry.comment}</span>}{' '}
                  {manager &&
                    open &&
                    (entry.decision === 'approved' || entry.decision === 'changes_requested') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          act.mutate(() => codeReviewsApi.dismissDecision(data.id, entry.user.id));
                        }}
                      >
                        {t('codeReviewDetail.dismissDecision')}
                      </Button>
                    )}
                  {writable && open && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('codeReviewDetail.removeReviewer', {
                        fullName: entry.user.fullName,
                      })}
                      onClick={() => {
                        act.mutate(() => codeReviewsApi.removeReviewer(data.id, entry.user.id));
                      }}
                    >
                      {t('codeReviewDetail.remove')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {writable && open && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (newReviewer !== '') {
                    act.mutate(() => codeReviewsApi.addReviewer(data.id, newReviewer));
                  }
                }}
              >
                <SelectField
                  label={t('codeReviewDetail.addReviewer')}
                  value={newReviewer}
                  options={[
                    { value: '', label: t('codeReviewDetail.chooseAMember') },
                    ...(members.data?.data ?? [])
                      .filter(
                        (member) =>
                          member.userId !== data.author.id &&
                          !data.reviewers.some((entry) => entry.user.id === member.userId),
                      )
                      .map((member) => ({ value: member.userId, label: member.fullName })),
                  ]}
                  onChange={(event) => {
                    setNewReviewer(event.target.value);
                  }}
                />
                <Button type="submit" size="sm">
                  {t('codeReviewDetail.add')}
                </Button>
              </form>
            )}
          </section>

          {(canDecide || (writable && open)) && (
            <section className="card" aria-labelledby="review-decision">
              <h2 id="review-decision">
                {canDecide ? t('codeReviewDetail.yourReview') : t('codeReviewDetail.comment')}
              </h2>
              <TextAreaField
                label={t('codeReviewDetail.reviewComment')}
                value={comment}
                onChange={(event) => {
                  setComment(event.target.value);
                }}
              />
              {canDecide && (
                <>
                  <Button
                    disabled={mine.decision === 'approved'}
                    onClick={() => {
                      act.mutate(() =>
                        codeReviewsApi.decide(data.id, { decision: 'approve', ...note }),
                      );
                    }}
                  >
                    {t('codeReviewDetail.approve')}
                  </Button>{' '}
                  <Button
                    variant="secondary"
                    disabled={mine.decision === 'changes_requested'}
                    onClick={() => {
                      act.mutate(() =>
                        codeReviewsApi.decide(data.id, { decision: 'request_changes', ...note }),
                      );
                    }}
                  >
                    {t('codeReviewDetail.requestChanges')}
                  </Button>{' '}
                  {(mine.decision === 'approved' || mine.decision === 'changes_requested') && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        act.mutate(() => codeReviewsApi.decide(data.id, { decision: 'revoke' }));
                      }}
                    >
                      {t('codeReviewDetail.revokeMyDecision')}
                    </Button>
                  )}{' '}
                </>
              )}
              {writable && (
                <Button
                  variant="ghost"
                  disabled={comment.trim() === ''}
                  onClick={() => {
                    act.mutate(() => codeReviewsApi.comment(data.id, comment.trim()));
                  }}
                >
                  {t('codeReviewDetail.addComment')}
                </Button>
              )}
            </section>
          )}

          <section className="card" aria-labelledby="review-work-items">
            <h2 id="review-work-items">{t('codeReviewDetail.workItems')}</h2>
            <ul aria-label={t('codeReviewDetail.reviewedWorkItems')}>
              {data.workItems.map((item) => (
                <li key={item.id}>
                  <Link to={`/work-items/${item.id}`}>
                    {item.key} · {item.title}
                  </Link>{' '}
                  <span className="muted">{humanize(item.status)}</span>{' '}
                  {writable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('codeReviewDetail.unlink', { key: item.key })}
                      onClick={() => {
                        act.mutate(() => codeReviewsApi.unlink(data.id, item.id));
                      }}
                    >
                      {t('codeReviewDetail.unlink2')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {writable && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (newWorkItem !== '') {
                    act.mutate(() => codeReviewsApi.link(data.id, newWorkItem));
                  }
                }}
              >
                <SelectField
                  label={t('codeReviewDetail.linkWorkItem')}
                  value={newWorkItem}
                  options={[
                    { value: '', label: t('codeReviewDetail.chooseAWorkItem') },
                    ...(workItems.data?.data ?? [])
                      .filter((item) => !data.workItems.some((linked) => linked.id === item.id))
                      .map((item) => ({ value: item.id, label: `${item.key} · ${item.title}` })),
                  ]}
                  onChange={(event) => {
                    setNewWorkItem(event.target.value);
                  }}
                />
                <Button type="submit" size="sm">
                  {t('codeReviewDetail.link')}
                </Button>
              </form>
            )}
          </section>

          <section className="card" aria-labelledby="review-history">
            <h2 id="review-history">{t('codeReviewDetail.history')}</h2>
            <ol aria-label={t('codeReviewDetail.reviewHistory')}>
              {data.events.map((event) => (
                <li key={event.id}>
                  <span className="muted">{formatDateTime(event.createdAt)}</span>{' '}
                  {event.actor?.fullName ?? t('codeReviewDetail.someone')} {humanize(event.kind)}
                  {event.subject !== null && ` (${event.subject.fullName})`}
                  {event.comment !== null && `: ${event.comment}`}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </DataState>
  );
}
