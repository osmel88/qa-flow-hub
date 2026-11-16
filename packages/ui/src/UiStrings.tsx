import { createContext, useContext } from 'react';

/**
 * Text the shared components render by themselves. The package stays free of
 * any i18n library: the app provides the strings in its own language, and
 * these English defaults apply without a provider.
 */
export interface UiStrings {
  loading: string;
  genericError: string;
  empty: string;
  showPassword: string;
  hidePassword: string;
}

export const DEFAULT_UI_STRINGS: UiStrings = {
  loading: 'Loading…',
  genericError: 'Something went wrong',
  empty: 'Nothing here yet',
  showPassword: 'Show password',
  hidePassword: 'Hide password',
};

const UiStringsContext = createContext<UiStrings>(DEFAULT_UI_STRINGS);

export const UiStringsProvider = UiStringsContext.Provider;

export function useUiStrings(): UiStrings {
  return useContext(UiStringsContext);
}
