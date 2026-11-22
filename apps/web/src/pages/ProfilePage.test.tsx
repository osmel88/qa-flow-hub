import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http-client';
import { LOCALE_STORAGE_KEY } from '../i18n/locales';
import { renderScreen } from '../test/render';

const changePassword = vi.fn();
const logout = vi.fn();

vi.mock('../api/endpoints', () => ({
  authApi: { changePassword: (...args: unknown[]) => changePassword(...args) },
  notificationsApi: {
    preferences: () => new Promise(() => undefined),
    updatePreferences: vi.fn(),
  },
}));
vi.mock('../auth/auth-context', () => ({
  useAuth: () => ({
    user: { fullName: 'Ana García', email: 'ana@example.com', avatarUrl: null },
    organizations: [
      { id: 'org_1', name: 'Acme', slug: 'acme', role: 'qa_lead' },
      { id: 'org_2', name: 'Globex', slug: 'globex', role: 'viewer' },
    ],
    logout,
  }),
}));
vi.mock('../components/MfaSettings', () => ({ MfaSettings: () => null }));

const CURRENT = 'Old-Passw0rd!';
const NEXT = 'N3w-Password!x';

async function renderProfile(locale: 'en' | 'es' = 'en') {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const { ProfilePage } = await import('./ProfilePage');
  renderScreen(<ProfilePage />);
  const heading = locale === 'en' ? 'Change password' : 'Cambiar contraseña';
  return screen.getByRole('heading', { name: heading }).closest('section') as HTMLElement;
}

beforeEach(() => {
  changePassword.mockReset();
  logout.mockReset();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('Profile — change password', () => {
  it('has an independent show/hide control on each of the three fields', async () => {
    const section = await renderProfile();
    const fields = ['Current password', 'New password', 'Confirm new password'].map((label) =>
      within(section).getByLabelText(label, { exact: true }),
    );
    await userEvent.type(fields[0] as HTMLElement, CURRENT);
    const toggles = within(section).getAllByRole('button', { name: 'Show password' });
    expect(toggles).toHaveLength(3);

    await userEvent.click(toggles[1] as HTMLElement);
    expect(fields[1]).toHaveAttribute('type', 'text');
    expect(fields[0]).toHaveAttribute('type', 'password');
    expect(fields[2]).toHaveAttribute('type', 'password');
    expect(toggles[1]).toHaveAttribute('aria-pressed', 'true');
    expect(toggles[1]).toHaveAccessibleName('Hide password');

    (toggles[0] as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    expect(fields[0]).toHaveAttribute('type', 'text');
    expect(fields[0]).toHaveValue(CURRENT);
  });

  it('keeps the button disabled until the confirmation matches, then sends only the API fields', async () => {
    changePassword.mockResolvedValue(undefined);
    const section = await renderProfile();
    const submit = within(section).getByRole('button', { name: 'Change password' });
    expect(submit).toBeDisabled();

    await userEvent.type(
      within(section).getByLabelText('Current password', { exact: true }),
      CURRENT,
    );
    await userEvent.type(within(section).getByLabelText('New password', { exact: true }), NEXT);
    await userEvent.type(
      within(section).getByLabelText('Confirm new password', { exact: true }),
      `${NEXT}x`,
    );
    expect(await within(section).findByText('The passwords do not match')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await userEvent.type(
      within(section).getByLabelText('Confirm new password', { exact: true }),
      '{Backspace}',
    );
    await waitFor(() => {
      expect(submit).toBeEnabled();
    });
    await userEvent.click(submit);

    expect(changePassword).toHaveBeenCalledWith({ currentPassword: CURRENT, newPassword: NEXT });
    expect(await within(section).findByRole('status')).toHaveTextContent(/password changed/i);
    expect(within(section).getByLabelText('New password', { exact: true })).toHaveValue('');
  });

  it('shows the shared password rules and keeps the button disabled', async () => {
    const section = await renderProfile();
    await userEvent.type(
      within(section).getByLabelText('Current password', { exact: true }),
      CURRENT,
    );
    await userEvent.type(within(section).getByLabelText('New password', { exact: true }), 'short');
    expect(
      await within(section).findByText('Password must be at least 12 characters'),
    ).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Change password' })).toBeDisabled();
  });

  it('reports a wrong current password and keeps what was typed', async () => {
    changePassword.mockRejectedValue(
      new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials'),
    );
    const section = await renderProfile();
    await userEvent.type(
      within(section).getByLabelText('Current password', { exact: true }),
      CURRENT,
    );
    await userEvent.type(within(section).getByLabelText('New password', { exact: true }), NEXT);
    await userEvent.type(
      within(section).getByLabelText('Confirm new password', { exact: true }),
      NEXT,
    );
    await userEvent.click(within(section).getByRole('button', { name: 'Change password' }));

    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'The current password is not correct.',
    );
    expect(within(section).getByLabelText('New password', { exact: true })).toHaveValue(NEXT);
    expect(logout).not.toHaveBeenCalled();
  });

  it('works in Spanish, with localized validation', async () => {
    const section = await renderProfile('es');
    expect(within(section).getAllByRole('button', { name: 'Mostrar contraseña' })).toHaveLength(3);
    await userEvent.type(
      within(section).getByLabelText('Contraseña actual', { exact: true }),
      CURRENT,
    );
    await userEvent.type(
      within(section).getByLabelText('Nueva contraseña', { exact: true }),
      CURRENT,
    );
    await userEvent.type(
      within(section).getByLabelText('Confirmar nueva contraseña', { exact: true }),
      'x',
    );
    expect(
      await within(section).findByText('La nueva contraseña debe ser distinta de la actual'),
    ).toBeInTheDocument();
    expect(within(section).getByText('Las contraseñas no coinciden')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Cambiar contraseña' })).toBeDisabled();
  });
});

describe('Profile — account and organizations', () => {
  it('shows the email untranslated, the avatar initials and each organization with role and status (ES)', async () => {
    await renderProfile('es');
    expect(screen.getByText('Correo electrónico')).toBeInTheDocument();
    expect(screen.getByText('ana@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('avatar')).toHaveTextContent('AG');

    const section = screen
      .getByRole('heading', { name: 'Organizaciones a las que perteneces' })
      .closest('section') as HTMLElement;
    const headers = within(section)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers).toEqual(['Organización', 'Rol en la organización', 'Estado de la membresía']);
    const rows = within(section).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'Acmelíder de QAActiva',
      'Globexsolo lecturaActiva',
    ]);
  });

  it('keeps the English role labels', async () => {
    await renderProfile('en');
    const section = screen
      .getByRole('heading', { name: 'Organizations you belong to' })
      .closest('section') as HTMLElement;
    expect(within(section).getByText('qa lead')).toBeInTheDocument();
    expect(within(section).getByText('viewer')).toBeInTheDocument();
  });
});
