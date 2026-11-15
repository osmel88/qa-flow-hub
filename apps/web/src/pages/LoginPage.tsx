import { loginSchema } from '@qa-flow-hub/shared';
import type { LoginInput, MfaChallengeView } from '@qa-flow-hub/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, PasswordField, TextField } from '@qa-flow-hub/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/http-client';
import { useAuth } from '../auth/auth-context';
import { AuthScreen } from '../components/AuthScreen';
import { useI18n } from '../i18n/i18n';

/**
 * Second step for accounts with MFA. The challenge token lives only in this
 * component's state: it is useless without the code, expires in minutes and
 * is single-use, so there is no reason to persist it anywhere.
 */
function MfaStep({
  challenge,
  onRestart,
}: {
  challenge: MfaChallengeView;
  onRestart: (message: string) => void;
}): React.JSX.Element {
  const { verifyMfa } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await verifyMfa(
        useRecovery
          ? { challengeToken: challenge.challengeToken, recoveryCode: value }
          : { challengeToken: challenge.challengeToken, code: value },
      );
      void navigate('/dashboard');
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'UNAUTHENTICATED') {
        // Expired, spent or out of attempts: only a new password step helps.
        onRestart(t('login.mfaExpired'));
        return;
      }
      setError(cause instanceof ApiError ? cause.message : t('login.mfaFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="card auth-card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      noValidate
    >
      <h1>{t('login.mfaTitle')}</h1>
      <p className="muted">{useRecovery ? t('login.mfaRecoveryIntro') : t('login.mfaCodeIntro')}</p>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      <TextField
        label={useRecovery ? t('login.mfaRecoveryCode') : t('login.mfaCode')}
        autoComplete="one-time-code"
        inputMode={useRecovery ? 'text' : 'numeric'}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" loading={submitting}>
        {t('login.mfaVerify')}
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setUseRecovery((current) => !current);
          setValue('');
          setError(null);
        }}
      >
        {useRecovery ? t('login.mfaUseAuthenticator') : t('login.mfaUseRecovery')}
      </Button>
    </form>
  );
}

export function LoginPage(): React.JSX.Element {
  const { login, user, isRestoring } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<MfaChallengeView | null>(null);
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
      const pending = await login(values);
      if (pending !== null) {
        setChallenge(pending);
        return;
      }
      void navigate('/dashboard');
    } catch (error) {
      // The API answers the same way for a wrong password and an unknown
      // account, and so does this screen: saying "no such user" would confirm
      // which addresses are registered.
      setFormError(error instanceof ApiError ? error.message : t('login.failed'));
    }
  });

  if (challenge !== null) {
    return (
      <AuthScreen>
        <MfaStep
          challenge={challenge}
          onRestart={(message) => {
            setChallenge(null);
            setFormError(message);
          }}
        />
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <form className="card auth-card" onSubmit={(event) => void onSubmit(event)} noValidate>
        <h1>{t('login.title')}</h1>
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
        <PasswordField
          label={t('common.password')}
          autoComplete="current-password"
          showLabel={t('common.showPassword')}
          hideLabel={t('common.hidePassword')}
          error={errors.password?.message}
          {...register('password')}
        />
        <p className="auth-card__aside">
          <Link to="/forgot-password">{t('login.forgotPassword')}</Link>
        </p>
        <Button type="submit" loading={isSubmitting}>
          {t('login.submit')}
        </Button>
        <p className="muted">
          {t('login.noAccount')} <Link to="/register">{t('login.createOne')}</Link>
        </p>
      </form>
    </AuthScreen>
  );
}
