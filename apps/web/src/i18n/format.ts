import { intlLocale } from './i18n';

/**
 * Dates and numbers in the active language, so a Spanish screen does not mix
 * an English `11/22/2026, 2:30:00 PM` into its sentences. `toLocaleString()`
 * without a locale would follow the browser instead of the language selector.
 */
export function formatDateTime(value: string | number | Date | null, empty = '—'): string {
  if (value === null) return empty;
  return new Date(value).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(intlLocale()).format(value);
}
