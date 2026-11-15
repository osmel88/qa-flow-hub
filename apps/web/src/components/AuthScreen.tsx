import type { ReactNode } from 'react';
import { LanguageSelector } from '../i18n/i18n';

/** Frame of the public authentication screens, with the language picker. */
export function AuthScreen({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <main className="auth-page">
      <div className="auth-page__language">
        <LanguageSelector />
      </div>
      {children}
    </main>
  );
}
