import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';
import { renderScreen } from '../test/render';
import { ApiError } from '../api/http-client';

const login = vi.fn();
const verifyMfa = vi.fn();

vi.mock('../auth/auth-context', () => ({
  useAuth: () => ({ login, verifyMfa, user: null, isRestoring: false }),
}));

describe('LoginPage', () => {
  it('refuses to call the API with an invalid email', async () => {
    const user = userEvent.setup();
    renderScreen(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), 'whatever');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('reports a rejected sign-in without hinting whether the account exists', async () => {
    login.mockRejectedValueOnce(new Error('Invalid email or password'));
    const user = userEvent.setup();
    renderScreen(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), 'person@example.com');
    await user.type(screen.getByLabelText('Password'), 'Str0ngPassword!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert').textContent).not.toMatch(/unknown|no such|not registered/i);
  });

  const signInWithPassword = async (user: ReturnType<typeof userEvent.setup>) => {
    login.mockResolvedValueOnce({ mfaRequired: true, challengeToken: 'challenge-token', expiresIn: 300 });
    renderScreen(<LoginPage />);
    await user.type(screen.getByLabelText('Email'), 'person@example.com');
    await user.type(screen.getByLabelText('Password'), 'Str0ngPassword!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Two-step verification' })).toBeInTheDocument();
  };

  it('asks for the authenticator code when the account has MFA', async () => {
    verifyMfa.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    await signInWithPassword(user);

    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(verifyMfa).toHaveBeenCalledWith({ challengeToken: 'challenge-token', code: '123456' });
    });
  });

  it('sends a recovery code instead when asked to', async () => {
    verifyMfa.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    await signInWithPassword(user);

    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), 'abcde-23456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(verifyMfa).toHaveBeenCalledWith({
        challengeToken: 'challenge-token',
        recoveryCode: 'abcde-23456',
      });
    });
  });

  it('keeps the code step for a wrong code and restarts for a spent challenge', async () => {
    const user = userEvent.setup();
    await signInWithPassword(user);

    verifyMfa.mockRejectedValueOnce(new ApiError(401, 'MFA_INVALID_CODE', 'The code is not valid'));
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The code is not valid');

    verifyMfa.mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED', 'Sign in again'));
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/expired/i);
  });
});
