import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../i18n/locales';
import { renderScreen } from '../test/render';

const setup = vi.fn();
const confirm = vi.fn();

vi.mock('../api/endpoints', () => ({
  mfaApi: {
    status: () =>
      Promise.resolve({
        enabled: false,
        confirmedAt: null,
        recoveryCodesRemaining: 0,
        sessionVerified: false,
      }),
    setup: (...args: unknown[]) => setup(...args),
    confirm: (...args: unknown[]) => confirm(...args),
    disable: vi.fn(),
    regenerateRecoveryCodes: vi.fn(),
  },
}));

async function renderMfa(locale: 'en' | 'es') {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const { MfaSettings } = await import('./MfaSettings');
  renderScreen(<MfaSettings />);
}

beforeEach(() => {
  setup.mockReset();
  confirm.mockReset();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('MFA setup validation', () => {
  it('keeps Set up MFA disabled while the password is empty and says why (EN)', async () => {
    await renderMfa('en');
    const button = await screen.findByRole('button', { name: 'Set up MFA' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Enter your current password to start the setup.')).toBeInTheDocument();
    await userEvent.click(button);
    expect(setup).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Current password'), 'Passw0rd-secret');
    expect(button).toBeEnabled();
  });

  it('rejects a code that is not 6 digits with a localized message, not a Zod one (ES)', async () => {
    setup.mockResolvedValueOnce({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x' });
    await renderMfa('es');
    const start = await screen.findByRole('button', { name: 'Configurar MFA' });
    expect(start).toBeDisabled();
    expect(
      screen.getByText('Introduce tu contraseña actual para empezar la configuración.'),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Contraseña actual'), 'Passw0rd-secret');
    await userEvent.click(start);
    expect(setup).toHaveBeenCalledWith('Passw0rd-secret');

    const code = await screen.findByLabelText('Código de autenticación');
    const turnOn = screen.getByRole('button', { name: 'Activar MFA' });
    expect(turnOn).toBeDisabled();
    await userEvent.type(code, '12ab');
    expect(screen.getByText('El código debe tener exactamente 6 dígitos.')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid|regex|String must/)).toBeNull();
    expect(turnOn).toBeDisabled();

    await userEvent.clear(code);
    await userEvent.type(code, '123 456');
    expect(screen.queryByText('El código debe tener exactamente 6 dígitos.')).toBeNull();
    expect(turnOn).toBeEnabled();
  });
});
