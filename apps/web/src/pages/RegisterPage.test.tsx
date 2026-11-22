import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http-client';
import { LOCALE_STORAGE_KEY } from '../i18n/locales';
import { renderScreen } from '../test/render';

const register = vi.fn();
vi.mock('../auth/auth-context', () => ({
  useAuth: () => ({ register, user: null, isRestoring: false }),
}));

async function renderRegister(locale: 'en' | 'es') {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const { RegisterPage } = await import('./RegisterPage');
  renderScreen(<RegisterPage />, '/register');
}

beforeEach(() => register.mockReset());
afterEach(() => window.localStorage.clear());

describe('Register', () => {
  it('names each invalid field in Spanish and does not call the API', async () => {
    await renderRegister('es');
    await userEvent.type(screen.getByLabelText('Nombre completo'), 'A');
    await userEvent.type(screen.getByLabelText('Correo electrónico'), 'no-es-un-correo');
    await userEvent.type(screen.getByLabelText('Contraseña', { exact: true }), 'corta');
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    expect(await screen.findByText('Introduce un correo electrónico válido')).toBeInTheDocument();
    expect(screen.getByText(/Debe tener al menos 2 /)).toBeInTheDocument();
    expect(screen.getByText('La contraseña debe tener al menos 12 caracteres')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid|String must/)).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('marks the email field when the address is already registered', async () => {
    register.mockRejectedValueOnce(
      new ApiError(409, 'DUPLICATE_RESOURCE', 'An account with this email already exists', [
        { path: 'email', message: 'An account with this email already exists' },
      ]),
    );
    await renderRegister('es');
    await userEvent.type(screen.getByLabelText('Nombre completo'), 'Ana García');
    await userEvent.type(screen.getByLabelText('Correo electrónico'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Contraseña', { exact: true }), 'Valid-Passw0rd');
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    expect(
      await screen.findByText(
        'Ya existe una cuenta con este correo. Inicia sesión o usa otro correo.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Correo electrónico')).toHaveAttribute('aria-invalid', 'true');
  });

  it('sends the three fields once they are valid (EN)', async () => {
    register.mockResolvedValueOnce(undefined);
    await renderRegister('en');
    await userEvent.type(screen.getByLabelText('Full name'), 'Ana García');
    await userEvent.type(screen.getByLabelText('Email'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Password', { exact: true }), 'Valid-Passw0rd');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(register).toHaveBeenCalledWith({
      fullName: 'Ana García',
      email: 'ana@example.com',
      password: 'Valid-Passw0rd',
    });
  });
});
