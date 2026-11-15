import { registerSchema } from '@qa-flow-hub/shared';
import type { RegisterInput } from '@qa-flow-hub/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, PasswordField, TextField } from '@qa-flow-hub/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { AuthScreen } from '../components/AuthScreen';
import { useI18n } from '../i18n/i18n';

export function RegisterPage(): React.JSX.Element {
  const { register: signUp } = useAuth();
  const { t } = useI18n();
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
      setFormError(error instanceof ApiError ? error.message : t('register.failed'));
    }
  });

  return (
    <AuthScreen>
      <form className="card auth-card" onSubmit={(event) => void onSubmit(event)} noValidate>
        <h1>{t('register.title')}</h1>
        {invitationToken !== undefined && <p className="muted">{t('register.invited')}</p>}
        {formError !== null && (
          <p className="ui-field__error" role="alert">
            {formError}
          </p>
        )}
        <TextField
          label={t('register.fullName')}
          error={errors.fullName?.message}
          {...register('fullName')}
        />
        <TextField
          label={t('common.email')}
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <PasswordField
          label={t('common.password')}
          autoComplete="new-password"
          showLabel={t('common.showPassword')}
          hideLabel={t('common.hidePassword')}
          hint={t('register.passwordHint')}
          error={errors.password?.message}
          {...register('password')}
        />
        <Button type="submit" loading={isSubmitting}>
          {t('register.submit')}
        </Button>
        <p className="muted">
          {t('register.alreadyRegistered')} <Link to="/login">{t('register.signIn')}</Link>
        </p>
      </form>
    </AuthScreen>
  );
}
