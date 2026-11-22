import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDateTime, formatNumber } from './format';
import { I18nProvider } from './i18n';
import { LOCALE_STORAGE_KEY } from './locales';

function useLocale(locale: 'en' | 'es'): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  render(
    <I18nProvider>
      <span />
    </I18nProvider>,
  );
}

afterEach(() => {
  window.localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe('locale formatting', () => {
  it('follows the language selector, not the browser', () => {
    useLocale('es');
    expect(formatNumber(12345.5)).toBe('12.345,5');
    expect(formatDateTime('2026-11-22T14:30:00Z')).toMatch(/nov/);
    useLocale('en');
    expect(formatNumber(12345.5)).toBe('12,345.5');
    expect(formatDateTime('2026-11-22T14:30:00Z')).toMatch(/Nov/);
  });

  it('prints the placeholder for a missing date', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(null, 'never')).toBe('never');
  });
});
