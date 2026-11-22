import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { UiStringsProvider } from '@qa-flow-hub/ui';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES, isLocale } from './locales';
import type { Locale } from './locales';
import { en } from './messages/en';
import type { MessageKey } from './messages/en';
import { es } from './messages/es';

type Catalog = Partial<Record<MessageKey, string>>;

const CATALOGS: Record<Locale, Catalog> = { en, es };

// The locale the module-level `t` reads. The provider sets it while rendering
// and remounts the routed tree on change, so plain functions (event handlers,
// helpers) translate too without a hook.
let activeLocale: Locale = DEFAULT_LOCALE;

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

// `{n, plural, one {# item} other {# items}}`: the branch Intl.PluralRules picks
// for `n` in the locale, with `#` replaced by the number.
const PLURAL = /\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g;

/**
 * Looks the key up in the locale, then in English; resolves plural blocks and
 * fills `{name}` placeholders.
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  const rules = new Intl.PluralRules(locale);
  const template = lookupMessage(CATALOGS[locale], key).replace(
    PLURAL,
    (match, name: string, one: string, other: string) => {
      if (!(name in vars)) return match;
      const count = Number(vars[name]);
      return (rules.select(count) === 'one' ? one : other).replace(/#/g, String(vars[name]));
    },
  );
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** A catalog lookup with the English fallback, exposed for tests. */
export function lookupMessage(catalog: Catalog, key: MessageKey): string {
  return catalog[key] ?? en[key];
}

/** The locale `t` currently translates into. */
export function currentLocale(): Locale {
  return activeLocale;
}

/** BCP 47 tag for `Intl` formatting in the active locale. */
export function intlLocale(): string {
  return activeLocale === 'es' ? 'es-ES' : 'en-US';
}

/** Translate in the active locale; usable outside React components. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(activeLocale, key, vars);
}

/**
 * Display label of a domain value (status, type, role...). Values are data,
 * not keys, so the lookup is by `value.<raw>` and falls back to the raw value
 * with underscores as spaces.
 */
export function valueLabel(value: string): string {
  const key = `value.${value}`;
  const catalog = CATALOGS[activeLocale] as Record<string, string | undefined>;
  return catalog[key] ?? value.replace(/_/g, ' ');
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
  activeLocale = locale;

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
  const uiStrings = useMemo(
    () => ({
      loading: translate(locale, 'common.loading'),
      genericError: translate(locale, 'common.genericError'),
      empty: translate(locale, 'common.nothingHereYet'),
      showPassword: translate(locale, 'common.showPassword'),
      hidePassword: translate(locale, 'common.hidePassword'),
    }),
    [locale],
  );
  return (
    <I18nContext.Provider value={value}>
      <UiStringsProvider value={uiStrings}>{children}</UiStringsProvider>
    </I18nContext.Provider>
  );
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
