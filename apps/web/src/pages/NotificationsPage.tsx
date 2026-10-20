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
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';

const STATUS_TONES: Record<NotificationStatus, BadgeTone> = {
  pending: 'info',
  sent: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

type Scope = 'mine' | 'organization';

function formatMoment(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}

function outcomeOf(row: NotificationView): string {
  if (row.status === 'failed') {
    const reason = humanize(row.failureReason ?? 'rejected');
    return row.nextAttemptAt === null
      ? `${reason} — no more automatic retries`
      : `${reason} — retry ${formatMoment(row.nextAttemptAt)}`;
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
        Mock outbox <Badge tone="warning">development only</Badge>
      </h2>
      <p className="muted">
        Messages the mock provider captured for this organization instead of sending them. Links
        that carry a token are redacted.
      </p>
      <DataState
        isPending={outbox.isPending}
        error={outbox.error}
        isEmpty={outbox.data?.data.length === 0}
        emptyMessage="No captured emails yet. Invite someone or assign a run to see one."
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
  const role = activeOrganization?.role;
  const canInspect = role === 'organization_owner' || role === 'organization_admin';
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
        title="Notifications"
        description="Every email qa-flow-hub decided to send you in this organization, and what happened to it. Change what you receive in your profile."
      />

      {provider.data !== undefined && (
        <p className="muted" role="status">
          Email provider: <strong>{provider.data.provider}</strong> ({provider.data.mode}
          {provider.data.inspectable ? ', nothing is actually delivered' : ''}) from{' '}
          {provider.data.fromAddress}. <Link to="/profile">Notification preferences</Link>
        </p>
      )}

      <section className="card filters" aria-label="Filters">
        {canInspect && (
          <label className="ui-field">
            <span className="ui-field__label">Scope</span>
            <select
              className="ui-input"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as Scope);
              }}
            >
              <option value="mine">Addressed to me</option>
              <option value="organization">Whole organization</option>
            </select>
          </label>
        )}
        <label className="ui-field">
          <span className="ui-field__label">Type</span>
          <select
            className="ui-input"
            value={type}
            onChange={(event) => {
              setType(event.target.value as NotificationType | '');
            }}
          >
            <option value="">All types</option>
            {NOTIFICATION_TYPES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="ui-field">
          <span className="ui-field__label">Status</span>
          <select
            className="ui-input"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as NotificationStatus | '');
            }}
          >
            <option value="">All statuses</option>
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
          emptyMessage="No notifications yet."
        >
          {retry.error !== null && (
            <p className="ui-field__error" role="alert">
              {retry.error instanceof Error ? retry.error.message : 'Retry failed'}
            </p>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Subject</th>
                {scope === 'organization' && <th>Recipient</th>}
                <th>Status</th>
                <th>Outcome</th>
                <th>Delivered</th>
                {canRetry && <th aria-label="Actions" />}
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
                          aria-label={`Retry ${row.subject}`}
                          disabled={retry.isPending}
                          onClick={() => {
                            retry.mutate(row.id);
                          }}
                        >
                          Retry now
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
