/**
 * Supported interface languages. Adding Portuguese is: a `pt` entry here and a
 * `messages/pt.ts` catalog (missing keys fall back to English).
 */
export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number]['code'];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'qaflow.locale';

export function isLocale(value: unknown): value is Locale {
  return SUPPORTED_LOCALES.some((entry) => entry.code === value);
}
