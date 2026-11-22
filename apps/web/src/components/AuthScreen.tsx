import type { ReactNode } from 'react';
import { LanguageSelector } from '../i18n/i18n';
import { Brand } from './Brand';

/** Frame of the public authentication screens: brand, language picker and the form. */
export function AuthScreen({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <main className="auth-page">
      <div className="auth-page__language">
        <LanguageSelector />
      </div>
      <div className="auth-page__content">
        <div className="auth-page__brand">
          <Brand size="lg" />
        </div>
        {children}
      </div>
    </main>
  );
}
