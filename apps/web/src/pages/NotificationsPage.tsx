import {
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  type NotificationStatus,
  type NotificationType,
  type NotificationView,
} from '@qa-flow-hub/shared';
import { Badge, type BadgeTone, Button, DataState } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { notificationsApi } from '../api/endpoints';
import { useAuth } from '../auth/auth-context';
import { hasCapability } from '../auth/capabilities';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';

const STATUS_TONES: Record<NotificationStatus, BadgeTone> = {
  pending: 'info',
  sent: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

type Scope = 'mine' | 'organization';

function formatMoment(value: string | null): string {
  return value === null ? '—' : formatDateTime(value);
}

function outcomeOf(row: NotificationView): string {
  if (row.status === 'failed') {
    const reason = humanize(row.failureReason ?? 'rejected');
    return row.nextAttemptAt === null
      ? t('notifications.noMoreAutomaticRetries', { reason })
      : t('notifications.retry', { reason, value: formatMoment(row.nextAttemptAt) });
  }
  if (row.status === 'skipped') {
    return humanize(row.skipReason ?? 'skipped');
  }
  return '';
}

/**
 * The development outbox is a separate table because it shows message bodies,
 * which the ledger deliberately never stores. It is only rendered while the
 * configured provider is inspectable (the mock) and only to owners/admins, the
 * same rule the API enforces.
 */
function MockOutbox(): React.JSX.Element {
  const outbox = useQuery({
    queryKey: ['notifications', 'outbox'],
    queryFn: () => notificationsApi.outbox({ pageSize: 50 }),
    staleTime: 0,
    refetchOnMount: 'always',
  });

  return (
    <section className="card" aria-labelledby="mock-outbox-title">
      <h2 id="mock-outbox-title">
        {t('notifications.mockOutbox')}{' '}
        <Badge tone="warning">{t('notifications.developmentOnly')}</Badge>
      </h2>
      <p className="muted">{t('notifications.messagesTheMockProviderCaptured')}</p>
      <DataState
        isPending={outbox.isPending}
        error={outbox.error}
        isEmpty={outbox.data?.data.length === 0}
        emptyMessage={t('notifications.noCapturedEmailsYetInvite')}
      >
        <ul className="plain-list">
          {outbox.data?.data.map((mail) => (
            <li key={mail.notificationId}>
              <details>
                <summary>
                  <strong>{mail.subject}</strong> → {mail.to}{' '}
                  <span className="muted">({formatMoment(mail.capturedAt)})</span>
                </summary>
                <pre className="token">{mail.text}</pre>
              </details>
            </li>
          ))}
        </ul>
      </DataState>
    </section>
  );
}

export function NotificationsPage(): React.JSX.Element {
  const { activeOrganization } = useAuth();
  const canInspect = hasCapability(activeOrganization, 'inspectNotifications');
  const [scope, setScope] = useState<Scope>('mine');
  const [type, setType] = useState<NotificationType | ''>('');
  const [status, setStatus] = useState<NotificationStatus | ''>('');
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: (id: string) => notificationsApi.retry(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const canRetry = canInspect && scope === 'organization';

  const provider = useQuery({
    queryKey: ['notifications', activeOrganization?.id, 'provider'],
    queryFn: () => notificationsApi.provider(),
  });
  const ledger = useQuery({
    queryKey: ['notifications', activeOrganization?.id, 'list', scope, type, status],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: () =>
      notificationsApi.list({
        scope,
        ...(type === '' ? {} : { type }),
        ...(status === '' ? {} : { status }),
        pageSize: 50,
      }),
  });

  return (
    <>
      <PageHeader
        title={t('notifications.notifications')}
        description={t('notifications.everyEmailQaFlowHub')}
      />

      {provider.data !== undefined && (
        <p className="muted" role="status">
          {t('notifications.emailProvider')} <strong>{provider.data.provider}</strong> (
          {provider.data.mode}
          {provider.data.inspectable ? t('notifications.nothingIsActuallyDelivered') : ''}
          {t('notifications.from')} {provider.data.fromAddress}.{' '}
          <Link to="/profile">{t('notifications.notificationPreferences')}</Link>
        </p>
      )}

      <section className="card filters" aria-label={t('notifications.filters')}>
        {canInspect && (
          <label className="ui-field">
            <span className="ui-field__label">{t('notifications.scope')}</span>
            <select
              className="ui-input"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as Scope);
              }}
            >
              <option value="mine">{t('notifications.addressedToMe')}</option>
              <option value="organization">{t('notifications.wholeOrganization')}</option>
            </select>
          </label>
        )}
        <label className="ui-field">
          <span className="ui-field__label">{t('notifications.type')}</span>
          <select
            className="ui-input"
            value={type}
            onChange={(event) => {
              setType(event.target.value as NotificationType | '');
            }}
          >
            <option value="">{t('notifications.allTypes')}</option>
            {NOTIFICATION_TYPES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="ui-field">
          <span className="ui-field__label">{t('notifications.status')}</span>
          <select
            className="ui-input"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as NotificationStatus | '');
            }}
          >
            <option value="">{t('notifications.allStatuses')}</option>
            {NOTIFICATION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="card">
        <DataState
          isPending={ledger.isPending}
          error={ledger.error}
          isEmpty={ledger.data?.data.length === 0}
          emptyMessage={t('notifications.noNotificationsYet')}
        >
          {retry.error !== null && (
            <p className="ui-field__error" role="alert">
              {retry.error instanceof Error ? retry.error.message : t('notifications.retryFailed')}
            </p>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>{t('notifications.when')}</th>
                <th>{t('notifications.type')}</th>
                <th>{t('notifications.subject')}</th>
                {scope === 'organization' && <th>{t('notifications.recipient')}</th>}
                <th>{t('notifications.status')}</th>
                <th>{t('notifications.outcome')}</th>
                <th>{t('notifications.delivered')}</th>
                {canRetry && <th aria-label={t('notifications.actions')} />}
              </tr>
            </thead>
            <tbody>
              {ledger.data?.data.map((row) => (
                <tr key={row.id}>
                  <td>{formatMoment(row.createdAt)}</td>
                  <td>{humanize(row.type)}</td>
                  <td>{row.subject}</td>
                  {scope === 'organization' && <td>{row.recipientEmail}</td>}
                  <td>
                    <Badge tone={STATUS_TONES[row.status]}>{row.status}</Badge>
                  </td>
                  <td>{outcomeOf(row)}</td>
                  <td>{formatMoment(row.deliveredAt)}</td>
                  {canRetry && (
                    <td>
                      {row.status === 'failed' && (
                        <Button
                          variant="secondary"
                          aria-label={t('notifications.retry2', { subject: row.subject })}
                          disabled={retry.isPending}
                          onClick={() => {
                            retry.mutate(row.id);
                          }}
                        >
                          {t('notifications.retryNow')}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </DataState>
      </section>

      {canInspect && provider.data?.inspectable === true && <MockOutbox />}
    </>
  );
}
