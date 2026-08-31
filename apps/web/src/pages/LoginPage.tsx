import { loginSchema } from '@qa-flow-hub/shared';
import type { LoginInput } from '@qa-flow-hub/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, TextField } from '@qa-flow-hub/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';

export function LoginPage(): React.JSX.Element {
  const { login, user, isRestoring } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  if (!isRestoring && user !== null) {
    return <Navigate to="/dashboard" replace />;
  }

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login(values);
      void navigate('/dashboard');
    } catch (error) {
      // The API answers the same way for a wrong password and an unknown
      // account, and so does this screen: saying "no such user" would confirm
      // which addresses are registered.
      setFormError(
        error instanceof ApiError ? error.message : 'Could not sign in. Try again.',
      );
    }
  });

  return (
    <main className="auth-page">
      <form className="card auth-card" onSubmit={(event) => void onSubmit(event)} noValidate>
        <h1>Sign in</h1>
        {formError !== null && (
          <p className="ui-field__error" role="alert">
            {formError}
          </p>
        )}
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
          autoComplete="current-password"
          error={errors.password?.message}
          {...register('password')}
        />
        <Button type="submit" loading={isSubmitting}>
          Sign in
        </Button>
        <p className="muted">
          No account? <Link to="/register">Create one</Link>
        </p>
      </form>
    </main>
  );
}
