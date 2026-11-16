import { Button, DataState, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MfaSetupView } from '@qa-flow-hub/shared';
import { useState } from 'react';
import { mfaApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { t } from '../i18n/i18n';

const message = (cause: unknown, fallback: string) =>
  cause instanceof ApiError ? cause.message : fallback;

/** Shown once, right after the server generated them; never fetched again. */
function RecoveryCodes({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}): React.JSX.Element {
  return (
    <div className="ui-state" role="status" data-testid="recovery-codes">
      <p>{t('c_mfaSettings.saveTheseRecoveryCodesSomewhere')}</p>
      <ul className="plain-list">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <Button type="button" onClick={onDone}>
        {t('c_mfaSettings.iSavedThem')}
      </Button>
    </div>
  );
}

/**
 * Account-level TOTP enrolment. The secret and the recovery codes only exist
 * in component state between the response and the moment the user moves on.
 */
export function MfaSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['mfa-status'], queryFn: () => mfaApi.status() });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<MfaSetupView | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = async (recoveryCodes: string[] | null) => {
    setPassword('');
    setCode('');
    setError(null);
    setCodes(recoveryCodes);
    // Turning MFA on or off changes what every tenant with a policy answers.
    await queryClient.invalidateQueries();
  };

  const setup = useMutation({
    mutationFn: () => mfaApi.setup(password),
    onSuccess: (view) => {
      setPending(view);
      setPassword('');
      setError(null);
    },
    onError: (cause) => setError(message(cause, t('c_mfaSettings.couldNotStartTheSetup'))),
  });
  const confirm = useMutation({
    mutationFn: () => mfaApi.confirm(code),
    onSuccess: async (view) => {
      setPending(null);
      await done(view.recoveryCodes);
    },
    onError: (cause) => setError(message(cause, t('c_mfaSettings.couldNotConfirmTheCode'))),
  });
  const regenerate = useMutation({
    mutationFn: () => mfaApi.regenerateRecoveryCodes(code),
    onSuccess: async (view) => done(view.recoveryCodes),
    onError: (cause) => setError(message(cause, t('c_mfaSettings.couldNotRegenerateTheCodes'))),
  });
  const disable = useMutation({
    mutationFn: () => mfaApi.disable(password, code),
    onSuccess: async () => done(null),
    onError: (cause) => setError(message(cause, t('c_mfaSettings.couldNotTurnMfaOff'))),
  });

  const data = status.data;
  return (
    <section className="card" aria-labelledby="mfa-title">
      <h2 id="mfa-title">{t('c_mfaSettings.multiFactorAuthentication')}</h2>
      <DataState isPending={status.isPending} error={status.error}>
        {error !== null && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
        {codes !== null && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

        {data !== undefined && !data.enabled && pending === null && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setup.mutate();
            }}
            noValidate
          >
            <p className="muted">{t('c_mfaSettings.protectYourAccountWithA')}</p>
            <TextField
              label={t('c_mfaSettings.currentPassword')}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" loading={setup.isPending}>
              {t('c_mfaSettings.setUpMfa')}
            </Button>
          </form>
        )}

        {pending !== null && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              confirm.mutate();
            }}
            noValidate
          >
            <p>{t('c_mfaSettings.addThisKeyToYour')}</p>
            <dl className="details">
              <dt>{t('c_mfaSettings.setupKey')}</dt>
              <dd>
                <code data-testid="mfa-secret">{pending.secret}</code>
              </dd>
              <dt>{t('c_mfaSettings.setupLink')}</dt>
              <dd>
                <a href={pending.otpauthUri}>{t('c_mfaSettings.openInAuthenticator')}</a>
              </dd>
            </dl>
            <TextField
              label={t('c_mfaSettings.authenticationCode')}
              autoComplete="one-time-code"
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button type="submit" loading={confirm.isPending}>
              {t('c_mfaSettings.turnOnMfa')}
            </Button>
          </form>
        )}

        {data?.enabled === true && (
          <>
            <dl className="details">
              <dt>{t('c_mfaSettings.status')}</dt>
              <dd>{t('c_mfaSettings.enabled')}</dd>
              <dt>{t('c_mfaSettings.recoveryCodesLeft')}</dt>
              <dd>{data.recoveryCodesRemaining}</dd>
              <dt>{t('c_mfaSettings.thisSession')}</dt>
              <dd>
                {data.sessionVerified
                  ? t('c_mfaSettings.verifiedWithMfa')
                  : t('c_mfaSettings.notVerifiedWithMfa')}
              </dd>
            </dl>
            <TextField
              label={t('c_mfaSettings.authenticationCode')}
              autoComplete="one-time-code"
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button
              type="button"
              variant="secondary"
              loading={regenerate.isPending}
              onClick={() => regenerate.mutate()}
            >
              {t('c_mfaSettings.newRecoveryCodes')}
            </Button>
            <TextField
              label={t('c_mfaSettings.passwordToTurnMfaOff')}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button
              type="button"
              variant="danger"
              loading={disable.isPending}
              onClick={() => disable.mutate()}
            >
              {t('c_mfaSettings.turnOffMfa')}
            </Button>
          </>
        )}
      </DataState>
    </section>
  );
}
