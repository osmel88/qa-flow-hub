import { changePasswordSchema } from '@qa-flow-hub/shared';
import type {
  ChangePasswordInput,
  NotificationPreferencesView,
  UpdateNotificationPreferencesInput,
} from '@qa-flow-hub/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Badge, Button, DataState, PasswordField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { authApi, notificationsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { Avatar } from '../components/Avatar';
import { MfaSettings } from '../components/MfaSettings';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { t } from '../i18n/i18n';
import { validationMessage } from '../i18n/validation';

type PreferenceKey = keyof UpdateNotificationPreferencesInput;

const PREFERENCES: ReadonlyArray<{ key: PreferenceKey; label: string; hint: string }> = [
  {
    key: 'emailEnabled',
    get label() {
      return t('profile.emailNotifications');
    },
    get hint() {
      return t('profile.masterSwitchForOptionalEmails');
    },
  },
  {
    key: 'testRunAssignments',
    get label() {
      return t('profile.testRunAssignments');
    },
    get hint() {
      return t('profile.whenSomeoneAssignsTestCases');
    },
  },
  {
    key: 'defectAssignments',
    get label() {
      return t('profile.defectAssignments');
    },
    get hint() {
      return t('profile.whenADefectIsAssigned');
    },
  },
  {
    key: 'statusChanges',
    get label() {
      return t('profile.importantStatusChanges');
    },
    get hint() {
      return t('profile.whenADefectYouReported');
    },
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
      setError(cause instanceof ApiError ? cause.message : t('profile.couldNotSaveThePreference'));
    },
  });

  return (
    <section className="card" aria-labelledby="notification-preferences-title">
      <h2 id="notification-preferences-title">{t('profile.notificationPreferences')}</h2>
      <p className="muted">
        {t('profile.theseApplyToYourAccount')}{' '}
        <Link to="/notifications">{t('profile.notifications')}</Link>.
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

const PASSWORDS_DO_NOT_MATCH = 'The passwords do not match';

/**
 * The API schema plus a confirmation that never leaves the browser. The rules
 * of the new password stay in the shared `changePasswordSchema`.
 */
function changePasswordFormSchema() {
  return z
    .object({ confirmPassword: z.string().min(1, 'Required') })
    .and(changePasswordSchema)
    .superRefine((value, context) => {
      if (value.confirmPassword !== value.newPassword) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['confirmPassword'],
          message: PASSWORDS_DO_NOT_MATCH,
        });
      }
    });
}

type ChangePasswordForm = ChangePasswordInput & { confirmPassword: string };

/** The one profile field a user edits here; the email is the login identity. */
function ProfileName(): React.JSX.Element {
  const { user, refreshOrganizations } = useAuth();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameError = name.trim().length < 2 ? t('profile.nameTooShort') : undefined;
  const save = useMutation({
    mutationFn: () => authApi.updateProfile({ fullName: name.trim() }),
    onSuccess: async () => {
      setError(null);
      setEditing(false);
      await refreshOrganizations();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('profile.nameSaveFailed'));
    },
  });

  if (!editing) {
    return (
      <>
        {user?.fullName}{' '}
        <Button
          variant="secondary"
          onClick={() => {
            setName(user?.fullName ?? '');
            setEditing(true);
          }}
        >
          {t('profile.nameEdit')}
        </Button>
      </>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      <TextField
        label={t('profile.name')}
        value={name}
        error={nameError}
        autoComplete="name"
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <div className="actions">
        <Button type="submit" loading={save.isPending} disabled={nameError !== undefined}>
          {t('profile.nameSave')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setEditing(false);
          }}
        >
          {t('profile.nameCancel')}
        </Button>
      </div>
    </form>
  );
}

export function ProfilePage(): React.JSX.Element {
  const { user, logout } = useAuth();
  const memberships = useQuery({
    queryKey: ['auth', 'memberships'],
    queryFn: () => authApi.memberships(),
  });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isValid },
  } = useForm<ChangePasswordForm>({
    resolver: zodResolver(changePasswordFormSchema()),
    mode: 'onChange',
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async ({ currentPassword, newPassword }) => {
    setError(null);
    setMessage(null);
    try {
      // The confirmation is a Web-only check; the API contract has no such field.
      await authApi.changePassword({ currentPassword, newPassword });
      reset();
      // Changing the password revokes every session, including this one, so
      // the honest thing is to send the user back to the login screen.
      setMessage(t('profile.passwordChangedEverySessionWas'));
      window.setTimeout(() => void logout(), 1500);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === 'INVALID_CREDENTIALS'
          ? t('profile.currentPasswordIsIncorrect')
          : cause instanceof ApiError
            ? cause.message
            : t('profile.couldNotChangeThePassword'),
      );
    }
  });

  const fieldError = (message: string | undefined) =>
    message === undefined ? undefined : validationMessage(message);

  return (
    <>
      <PageHeader
        title={t('profile.profile')}
        description={t('profile.yourAccountAndTheOrganizations')}
      />

      <section className="card">
        <h2>{t('profile.account')}</h2>
        <div className="profile-identity">
          <Avatar name={user?.fullName} email={user?.email} avatarUrl={user?.avatarUrl} size="lg" />
          <dl className="details">
            <dt>{t('profile.name')}</dt>
            <dd>
              <ProfileName />
            </dd>
            <dt>{t('profile.email')}</dt>
            <dd>
              {user?.email}
              <p className="muted">{t('profile.emailHint')}</p>
            </dd>
            <dt>{t('profile.avatar')}</dt>
            <dd>
              <p className="muted">{t('profile.avatarHint')}</p>
            </dd>
          </dl>
        </div>
      </section>

      <section className="card" aria-labelledby="memberships-title">
        <h2 id="memberships-title">{t('profile.memberships')}</h2>
        <p className="muted">{t('profile.membershipsIntro')}</p>
        <DataState
          isPending={memberships.isPending}
          error={memberships.error}
          isEmpty={(memberships.data ?? []).length === 0}
          emptyMessage={t('profile.noMemberships')}
        >
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('profile.organization')}</th>
                <th scope="col">{t('profile.organizationRole')}</th>
                <th scope="col">{t('profile.membershipStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {(memberships.data ?? []).map((membership) => (
                <tr key={membership.organizationId}>
                  <td>{membership.organizationName}</td>
                  <td>{humanize(membership.role)}</td>
                  <td>
                    {membership.status === 'active' ? (
                      <Badge tone="success">{t('profile.membershipActive')}</Badge>
                    ) : (
                      <Badge tone="warning">{t('profile.membershipSuspended')}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataState>
      </section>

      <MfaSettings />

      <NotificationPreferences />

      <section className="card" aria-labelledby="change-password-title">
        <h2 id="change-password-title">{t('profile.changePassword')}</h2>
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
          <PasswordField
            label={t('profile.currentPassword')}
            autoComplete="current-password"
            error={fieldError(errors.currentPassword?.message)}
            {...register('currentPassword')}
          />
          <PasswordField
            label={t('profile.newPassword')}
            autoComplete="new-password"
            error={fieldError(errors.newPassword?.message)}
            {...register('newPassword', { deps: ['confirmPassword'] })}
          />
          <PasswordField
            label={t('profile.confirmNewPassword')}
            autoComplete="new-password"
            error={fieldError(errors.confirmPassword?.message)}
            {...register('confirmPassword')}
          />
          <Button type="submit" loading={isSubmitting} disabled={!isValid || isSubmitting}>
            {t('profile.changePassword')}
          </Button>
        </form>
      </section>
    </>
  );
}
