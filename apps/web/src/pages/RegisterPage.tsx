import { registerSchema } from '@qa-flow-hub/shared';
import type { RegisterInput } from '@qa-flow-hub/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, TextField } from '@qa-flow-hub/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';

export function RegisterPage(): React.JSX.Element {
  const { register: signUp } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const invitationToken = params.get('invitation') ?? undefined;
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      // Signing up and joining are one request: two would strand an invited
      // user with an account and no organization if the second one failed.
      // The token is merged here rather than kept in a hidden field: an empty
      // string is not a valid token and would fail validation invisibly.
      await signUp({
        ...values,
        ...(invitationToken === undefined ? {} : { invitationToken }),
      });
      void navigate(invitationToken === undefined ? '/organizations' : '/dashboard');
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Could not create the account.');
    }
  });

  return (
    <main className="auth-page">
      <form className="card auth-card" onSubmit={(event) => void onSubmit(event)} noValidate>
        <h1>Create your account</h1>
        {invitationToken !== undefined && (
          <p className="muted">You are joining an organization you were invited to.</p>
        )}
        {formError !== null && (
          <p className="ui-field__error" role="alert">
            {formError}
          </p>
        )}
        <TextField label="Full name" error={errors.fullName?.message} {...register('fullName')} />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters, with an uppercase letter and a digit."
          error={errors.password?.message}
          {...register('password')}
        />
        <Button type="submit" loading={isSubmitting}>
          Create account
        </Button>
        <p className="muted">
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
