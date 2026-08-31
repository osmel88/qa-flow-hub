import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';
import { renderScreen } from '../test/render';

const login = vi.fn();

vi.mock('../auth/auth-context', () => ({
  useAuth: () => ({ login, user: null, isRestoring: false }),
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
});
