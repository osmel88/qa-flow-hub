import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, LanguageSelector, translate, useI18n } from './i18n';
import { LOCALE_STORAGE_KEY } from './locales';
import { en } from './messages/en';
import { es } from './messages/es';

vi.mock('../auth/auth-context', () => ({
  useAuth: () => ({ login: vi.fn(), verifyMfa: vi.fn(), user: null, isRestoring: false }),
}));

function Probe(): React.JSX.Element {
  const { t } = useI18n();
  return <p>{t('login.title')}</p>;
}

describe('i18n', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('has a Spanish entry for every English key', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it('fills placeholders and falls back to English', () => {
    expect(translate('es', 'forgot.sent', { minutes: 30 })).toContain('30 minutos');
    expect(translate('en', 'forgot.sent', { minutes: 30 })).toContain('30 minutes');
  });

  it('switches language, persists it and sets the document language', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <I18nProvider>
        <LanguageSelector />
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('Sign in')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'es');
    expect(screen.getByText('Iniciar sesión')).toBeInTheDocument();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    unmount();

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('Iniciar sesión')).toBeInTheDocument();
  });

  it('ignores an unknown stored language', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'xx');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('translates the login screen without duplicating it', async () => {
    const { LoginPage } = await import('../pages/LoginPage');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    render(
      <I18nProvider>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Mostrar contraseña' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '¿Olvidaste tu contraseña?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });
});
