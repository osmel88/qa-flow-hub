import { changePasswordSchema } from '@qa-flow-hub/shared';
import type {
  ChangePasswordInput,
  NotificationPreferencesView,
  UpdateNotificationPreferencesInput,
} from '@qa-flow-hub/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, DataState, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { authApi, notificationsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';

type PreferenceKey = keyof UpdateNotificationPreferencesInput;

const PREFERENCES: ReadonlyArray<{ key: PreferenceKey; label: string; hint: string }> = [
  {
    key: 'emailEnabled',
    label: 'Email notifications',
    hint: 'Master switch for optional emails. Security notices such as password changes and organization invitations are always sent.',
  },
  {
    key: 'testRunAssignments',
    label: 'Test run assignments',
    hint: 'When someone assigns test cases in a run to you.',
  },
  {
    key: 'defectAssignments',
    label: 'Defect assignments',
    hint: 'When a defect is assigned to you.',
  },
  {
    key: 'statusChanges',
    label: 'Important status changes',
    hint: 'When a defect you reported or own is resolved, closed, rejected or reopened.',
  },
];

function NotificationPreferences(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const preferences = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => notificationsApi.preferences(),
  });
  const update = useMutation({
    mutationFn: (body: UpdateNotificationPreferencesInput) =>
      notificationsApi.updatePreferences(body),
    onMutate: (body: UpdateNotificationPreferencesInput) => {
      const previous = queryClient.getQueryData<NotificationPreferencesView>([
        'notification-preferences',
      ]);
      if (previous !== undefined) {
        queryClient.setQueryData<NotificationPreferencesView>(['notification-preferences'], {
          emailEnabled: body.emailEnabled ?? previous.emailEnabled,
          testRunAssignments: body.testRunAssignments ?? previous.testRunAssignments,
          defectAssignments: body.defectAssignments ?? previous.defectAssignments,
          statusChanges: body.statusChanges ?? previous.statusChanges,
          updatedAt: previous.updatedAt,
        });
      }
      return { previous };
    },
    onSuccess: (view: NotificationPreferencesView) => {
      setError(null);
      queryClient.setQueryData(['notification-preferences'], view);
    },
    onError: (cause: unknown, _body, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['notification-preferences'], context.previous);
      }
      setError(cause instanceof ApiError ? cause.message : 'Could not save the preference.');
    },
  });

  return (
    <section className="card" aria-labelledby="notification-preferences-title">
      <h2 id="notification-preferences-title">Notification preferences</h2>
      <p className="muted">
        These apply to your account in every organization. See what was sent to you in{' '}
        <Link to="/notifications">Notifications</Link>.
      </p>
      <DataState isPending={preferences.isPending} error={preferences.error}>
        {error !== null && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
        <ul className="plain-list">
          {PREFERENCES.map((preference) => {
            const checked = preferences.data?.[preference.key] ?? true;
            const optional = preference.key !== 'emailEnabled';
            const disabled =
              update.isPending || (optional && preferences.data?.emailEnabled === false);
            return (
              <li key={preference.key}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => update.mutate({ [preference.key]: event.target.checked })}
                  />
                  {preference.label}
                </label>
                <p className="muted">{preference.hint}</p>
              </li>
            );
          })}
        </ul>
      </DataState>
    </section>
  );
}

export function ProfilePage(): React.JSX.Element {
  const { user, organizations, logout } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    setMessage(null);
    try {
      await authApi.changePassword(values);
      reset();
      // Changing the password revokes every session, including this one, so
      // the honest thing is to send the user back to the login screen.
      setMessage('Password changed. Every session was closed; sign in again.');
      window.setTimeout(() => void logout(), 1500);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not change the password.');
    }
  });

  return (
    <>
      <PageHeader title="Profile" description="Your account and the organizations you belong to." />

      <section className="card">
        <h2>Account</h2>
        <dl className="details">
          <dt>Name</dt>
          <dd>{user?.fullName}</dd>
          <dt>Email</dt>
          <dd>{user?.email}</dd>
        </dl>
        <h3>Memberships</h3>
        <ul className="plain-list">
          {organizations.map((organization) => (
            <li key={organization.id}>
              {organization.name} — {humanize(organization.role)}
            </li>
          ))}
        </ul>
      </section>

      <NotificationPreferences />

      <section className="card">
        <h2>Change password</h2>
        <form onSubmit={(event) => void onSubmit(event)} noValidate>
          {error !== null && (
            <p className="ui-field__error" role="alert">
              {error}
            </p>
          )}
          {message !== null && (
            <p className="ui-state" role="status">
              {message}
            </p>
          )}
          <TextField
            label="Current password"
            type="password"
            autoComplete="current-password"
            error={errors.currentPassword?.message}
            {...register('currentPassword')}
          />
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            error={errors.newPassword?.message}
            {...register('newPassword')}
          />
          <Button type="submit" loading={isSubmitting}>
            Change password
          </Button>
        </form>
      </section>
    </>
  );
}
