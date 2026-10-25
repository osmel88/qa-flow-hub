import { Button, DataState, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MfaSetupView } from '@qa-flow-hub/shared';
import { useState } from 'react';
import { mfaApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';

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
      <p>
        Save these recovery codes somewhere safe. Each one signs you in once if you lose your
        authenticator. They will not be shown again.
      </p>
      <ul className="plain-list">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <Button type="button" onClick={onDone}>
        I saved them
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
    onError: (cause) => setError(message(cause, 'Could not start the setup.')),
  });
  const confirm = useMutation({
    mutationFn: () => mfaApi.confirm(code),
    onSuccess: async (view) => {
      setPending(null);
      await done(view.recoveryCodes);
    },
    onError: (cause) => setError(message(cause, 'Could not confirm the code.')),
  });
  const regenerate = useMutation({
    mutationFn: () => mfaApi.regenerateRecoveryCodes(code),
    onSuccess: async (view) => done(view.recoveryCodes),
    onError: (cause) => setError(message(cause, 'Could not regenerate the codes.')),
  });
  const disable = useMutation({
    mutationFn: () => mfaApi.disable(password, code),
    onSuccess: async () => done(null),
    onError: (cause) => setError(message(cause, 'Could not turn MFA off.')),
  });

  const data = status.data;
  return (
    <section className="card" aria-labelledby="mfa-title">
      <h2 id="mfa-title">Multi-factor authentication</h2>
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
            <p className="muted">
              Protect your account with a code from an authenticator app. It applies in every
              organization you belong to.
            </p>
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" loading={setup.isPending}>
              Set up MFA
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
            <p>Add this key to your authenticator app, then enter the code it shows.</p>
            <dl className="details">
              <dt>Setup key</dt>
              <dd>
                <code data-testid="mfa-secret">{pending.secret}</code>
              </dd>
              <dt>Setup link</dt>
              <dd>
                <a href={pending.otpauthUri}>Open in authenticator</a>
              </dd>
            </dl>
            <TextField
              label="Authentication code"
              autoComplete="one-time-code"
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button type="submit" loading={confirm.isPending}>
              Turn on MFA
            </Button>
          </form>
        )}

        {data?.enabled === true && (
          <>
            <dl className="details">
              <dt>Status</dt>
              <dd>Enabled</dd>
              <dt>Recovery codes left</dt>
              <dd>{data.recoveryCodesRemaining}</dd>
              <dt>This session</dt>
              <dd>{data.sessionVerified ? 'Verified with MFA' : 'Not verified with MFA'}</dd>
            </dl>
            <TextField
              label="Authentication code"
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
              New recovery codes
            </Button>
            <TextField
              label="Password to turn MFA off"
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
              Turn off MFA
            </Button>
          </>
        )}
      </DataState>
    </section>
  );
}
