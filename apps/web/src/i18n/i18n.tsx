import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES, isLocale } from './locales';
import type { Locale } from './locales';
import { en } from './messages/en';
import type { MessageKey } from './messages/en';
import { es } from './messages/es';

type Catalog = Partial<Record<MessageKey, string>>;

const CATALOGS: Record<Locale, Catalog> = { en, es };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Looks the key up in the locale, then in English; fills `{name}` placeholders. */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  const template = CATALOGS[locale][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

function storedLocale(): Locale {
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

// Without a provider (isolated component tests) everything renders in English.
const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
});

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(storedLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Private mode or storage disabled: the choice lasts for this page only.
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/** Language picker shared by the app header and the public auth screens. */
export function LanguageSelector({
  className = 'language-selector',
  labelClassName = 'language-selector__label',
}: {
  className?: string;
  labelClassName?: string;
}): React.JSX.Element {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className={className}>
      <span className={labelClassName}>{t('common.language')}</span>
      <select
        className="ui-input"
        aria-label={t('common.language')}
        value={locale}
        onChange={(event) => {
          if (isLocale(event.target.value)) {
            setLocale(event.target.value);
          }
        }}
      >
        {SUPPORTED_LOCALES.map((entry) => (
          <option key={entry.code} value={entry.code} lang={entry.code}>
            {entry.label}
          </option>
        ))}
      </select>
    </label>
  );
}
