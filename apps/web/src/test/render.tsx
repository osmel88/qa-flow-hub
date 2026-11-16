import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n/i18n';

/**
 * Every screen needs a query client and a router. A fresh client per test
 * matters: sharing one would let a cached response from an earlier test
 * satisfy a later one and hide a broken request.
 */
export function renderScreen(ui: ReactNode, initialPath = '/'): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <I18nProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
