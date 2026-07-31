import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthPage } from './HealthPage';

function renderWithQuery(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <HealthPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HealthPage', () => {
  it('shows the API status once the request resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ status: 'ok', uptimeSeconds: 12 }), { status: 200 }),
      ),
    );

    renderWithQuery();

    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.getByText('12s')).toBeInTheDocument();
  });

  it('surfaces an unreachable API instead of failing silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));

    renderWithQuery();

    expect(await screen.findByRole('alert')).toHaveTextContent('not reachable');
  });
});
