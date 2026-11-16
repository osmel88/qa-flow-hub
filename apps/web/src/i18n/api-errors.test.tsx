import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/http-client';
import { apiErrorMessage } from './api-errors';
import { currentLocale } from './i18n';
import { renderScreen } from '../test/render';
import { LOCALE_STORAGE_KEY } from './locales';

/** Renders nothing; mounting the provider sets the active locale for `t`. */
function useLocale(locale: 'en' | 'es') {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  renderScreen(<span />);
  expect(currentLocale()).toBe(locale);
}

afterEach(() => {
  window.localStorage.clear();
});

describe('API error messages', () => {
  it('keeps the specific English message of the API in English', () => {
    useLocale('en');
    const error = new ApiError(403, 'FORBIDDEN', 'Your role does not allow this action');
    expect(error.message).toBe('Your role does not allow this action');
  });

  it('translates a permission error by its code in Spanish', () => {
    useLocale('es');
    const error = new ApiError(403, 'FORBIDDEN', 'Your role does not allow this action');
    expect(error.message).toBe('Tu rol no permite realizar esta acción.');
    expect(error.serverMessage).toBe('Your role does not allow this action');
    expect(error.code).toBe('FORBIDDEN');
  });

  it.each([
    ['UNAUTHENTICATED', 'Tu sesión ha terminado. Vuelve a iniciar sesión.'],
    ['NOT_FOUND', 'El recurso no existe o no tienes acceso a él.'],
    ['DUPLICATE_RESOURCE', 'Ya existe un recurso con esos valores.'],
    [
      'VALIDATION_ERROR',
      'Algunos valores no son válidos. Revisa el formulario e inténtalo de nuevo.',
    ],
    ['PLAN_LIMIT_REACHED', 'Has alcanzado el límite de tu plan.'],
    [
      'CONFLICT',
      'La acción entra en conflicto con el estado actual. Recarga e inténtalo de nuevo.',
    ],
    ['RATE_LIMITED', 'Demasiadas peticiones. Espera un momento e inténtalo de nuevo.'],
  ])('translates %s in Spanish', (code, expected) => {
    useLocale('es');
    expect(apiErrorMessage(code, 'Some English text')).toBe(expected);
  });

  it('falls back to a generic line for an unknown code, without the server text', () => {
    useLocale('es');
    const error = new ApiError(418, 'TEAPOT', 'Internal detail: table users_x');
    expect(error.message).toBe('No se pudo completar la acción. Inténtalo de nuevo.');
    expect(error.message).not.toContain('users_x');
  });

  it('follows a language change without recreating the error', () => {
    useLocale('es');
    const error = new ApiError(403, 'FORBIDDEN', 'Your role does not allow this action');
    expect(error.message).toBe('Tu rol no permite realizar esta acción.');
    useLocale('en');
    expect(error.message).toBe('Your role does not allow this action');
  });
});
