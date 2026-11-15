import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http-client';
import { renderScreen } from '../test/render';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { ResetPasswordPage } from './ResetPasswordPage';

const forgotPassword = vi.fn();
const resetPassword = vi.fn();

vi.mock('../api/endpoints', () => ({
  authApi: {
    forgotPassword: (...args: unknown[]) => forgotPassword(...args),
    resetPassword: (...args: unknown[]) => resetPassword(...args),
  },
}));

describe('password recovery', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('answers the same way for any address and shows the mock link only when given', async () => {
    forgotPassword.mockResolvedValueOnce({ accepted: true });
    const user = userEvent.setup();
    renderScreen(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText('Email'), 'ada@example.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/If an account exists/);
    expect(screen.queryByTestId('mock-reset')).toBeNull();
    expect(forgotPassword).toHaveBeenCalledWith({ email: 'ada@example.test' });
  });

  it('shows the mock provider link as an in-app path', async () => {
    forgotPassword.mockResolvedValueOnce({
      accepted: true,
      mockResetUrl: 'http://localhost:5173/reset-password?token=abc',
    });
    const user = userEvent.setup();
    renderScreen(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText('Email'), 'ada@example.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('link', { name: 'Open the reset link' })).toHaveAttribute(
      'href',
      '/reset-password?token=abc',
    );
  });

  it('checks policy and confirmation before calling the API', async () => {
    const user = userEvent.setup();
    renderScreen(<ResetPasswordPage />, '/reset-password?token=t'.padEnd(60, 'x'));
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/at least 12 characters/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'N3wPassword!!');
    await user.type(screen.getByLabelText('Confirm new password'), 'Different1!!x');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('sets the password once and reports a spent or expired link', async () => {
    resetPassword.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    const token = 'a'.repeat(43);
    renderScreen(<ResetPasswordPage />, `/reset-password?token=${token}`);
    await user.type(screen.getByLabelText('New password'), 'N3wPassword!!');
    await user.type(screen.getByLabelText('Confirm new password'), 'N3wPassword!!');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/every session was signed out/);
    expect(resetPassword).toHaveBeenCalledWith({ token, newPassword: 'N3wPassword!!' });
  });

  it('turns a refused token into an invalid-link message', async () => {
    resetPassword.mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', 'invalid'));
    const user = userEvent.setup();
    renderScreen(<ResetPasswordPage />, `/reset-password?token=${'b'.repeat(43)}`);
    await user.type(screen.getByLabelText('New password'), 'N3wPassword!!');
    await user.type(screen.getByLabelText('Confirm new password'), 'N3wPassword!!');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('invalid or has expired');
    });
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toBeInTheDocument();
  });

  it('explains a link without a token', () => {
    renderScreen(<ResetPasswordPage />, '/reset-password');
    expect(screen.getByRole('alert')).toHaveTextContent('no reset token');
  });
});
