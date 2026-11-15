import { PASSWORD_RESET_TTL_MINUTES, forgotPasswordSchema } from '@qa-flow-hub/shared';
import type { ForgotPasswordInput, ForgotPasswordView } from '@qa-flow-hub/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, TextField } from '@qa-flow-hub/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { authApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { AuthScreen } from '../components/AuthScreen';
import { useI18n } from '../i18n/i18n';

/** In-app path of a reset link, so the mock link stays in this tab and origin. */
function toAppPath(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function ForgotPasswordPage(): React.JSX.Element {
  const { t } = useI18n();
  const [result, setResult] = useState<ForgotPasswordView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      setResult(await authApi.forgotPassword(values));
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : t('forgot.failed'));
    }
  });

  return (
    <AuthScreen>
      <form className="card auth-card" onSubmit={(event) => void onSubmit(event)} noValidate>
        <h1>{t('forgot.title')}</h1>
        {result === null ? (
          <>
            <p className="muted">{t('forgot.intro')}</p>
            {formError !== null && (
              <p className="ui-field__error" role="alert">
                {formError}
              </p>
            )}
            <TextField
              label={t('common.email')}
              type="email"
              autoComplete="email"
              error={errors.email?.message}
              {...register('email')}
            />
            <Button type="submit" loading={isSubmitting}>
              {t('forgot.submit')}
            </Button>
          </>
        ) : (
          <div role="status">
            <p>{t('forgot.sent', { minutes: PASSWORD_RESET_TTL_MINUTES })}</p>
            {result.mockResetUrl !== undefined && (
              <div className="notice" data-testid="mock-reset">
                <p className="muted">{t('forgot.mockNotice')}</p>
                {result.mockResetUrl === null ? (
                  <p>{t('forgot.mockNoLink')}</p>
                ) : (
                  <Link to={toAppPath(result.mockResetUrl)}>{t('forgot.mockLink')}</Link>
                )}
              </div>
            )}
          </div>
        )}
        <p className="muted">
          <Link to="/login">{t('common.backToSignIn')}</Link>
        </p>
      </form>
    </AuthScreen>
  );
}
