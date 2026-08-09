import { changePasswordSchema } from '@qa-flow-hub/shared';
import type { ChangePasswordInput } from '@qa-flow-hub/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, TextField } from '@qa-flow-hub/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { authApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';

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
