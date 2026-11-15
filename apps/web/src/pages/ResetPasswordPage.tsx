import { passwordSchema } from '@qa-flow-hub/shared';
import { Button, PasswordField } from '@qa-flow-hub/ui';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { AuthScreen } from '../components/AuthScreen';
import { useI18n } from '../i18n/i18n';

type Outcome = 'idle' | 'done' | 'invalid';

export function ResetPasswordPage(): React.JSX.Element {
  const { t } = useI18n();
  const [params] = useSearchParams();
  // Read once, then dropped from the address bar and history so the token
  // does not linger in the URL, a bookmark or a screenshot.
  const [token] = useState(() => params.get('token'));
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>('idle');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (params.has('token')) {
      window.history.replaceState(window.history.state, '', '/reset-password');
    }
  }, [params]);

  const policy = passwordSchema.safeParse(password);
  const passwordError = submitted && !policy.success ? policy.error.issues[0]?.message : undefined;
  const confirmationError =
    submitted && confirmation !== password ? t('reset.mismatch') : undefined;

  const submit = async () => {
    setSubmitted(true);
    setFormError(null);
    if (token === null || !policy.success || confirmation !== password) return;
    setSubmitting(true);
    try {
      await authApi.resetPassword({ token, newPassword: password });
      setOutcome('done');
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        setOutcome('invalid');
      } else {
        setFormError(error instanceof ApiError ? error.message : t('common.genericError'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const body = () => {
    if (token === null || outcome === 'invalid') {
      return (
        <>
          <p className="ui-field__error" role="alert">
            {token === null ? t('reset.missingToken') : t('reset.invalid')}
          </p>
          <p>
            <Link to="/forgot-password">{t('reset.requestNew')}</Link>
          </p>
        </>
      );
    }
    if (outcome === 'done') {
      return (
        <p role="status">
          {t('reset.done')} <Link to="/login">{t('login.submit')}</Link>
        </p>
      );
    }
    return (
      <>
        {formError !== null && (
          <p className="ui-field__error" role="alert">
            {formError}
          </p>
        )}
        <PasswordField
          label={t('reset.newPassword')}
          autoComplete="new-password"
          hint={t('register.passwordHint')}
          showLabel={t('common.showPassword')}
          hideLabel={t('common.hidePassword')}
          error={passwordError}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <PasswordField
          label={t('reset.confirmPassword')}
          autoComplete="new-password"
          showLabel={t('common.showPassword')}
          hideLabel={t('common.hidePassword')}
          error={confirmationError}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <Button type="submit" loading={submitting}>
          {t('reset.submit')}
        </Button>
      </>
    );
  };

  return (
    <AuthScreen>
      <form
        className="card auth-card"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h1>{t('reset.title')}</h1>
        {body()}
        <p className="muted">
          <Link to="/login">{t('common.backToSignIn')}</Link>
        </p>
      </form>
    </AuthScreen>
  );
}
