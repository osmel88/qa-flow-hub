import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http-client';
import { AuthProvider, useAuth } from './auth-context';

const me = vi.fn();

vi.mock('../api/endpoints', () => ({
  authApi: { me: (...args: unknown[]) => me(...args) },
  mfaApi: {},
}));

vi.mock('../api/http-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/http-client')>()),
  refreshSession: () => Promise.resolve(true),
  setSessionLostHandler: () => undefined,
}));

function profile(role: string) {
  return {
    id: 'usr_1',
    email: 'ana@example.com',
    fullName: 'Ana',
    avatarUrl: null,
    mfaEnabled: false,
    organizations: [{ id: 'org_1', name: 'Acme', slug: 'acme', role, requireMfa: false }],
  };
}

function Role(): React.JSX.Element {
  const { activeOrganization } = useAuth();
  const denied = useMutation({
    mutationFn: () =>
      Promise.reject(new ApiError(403, 'FORBIDDEN', 'Your role does not allow this action')),
  });
  return (
    <>
      <p data-testid="role">{activeOrganization?.role ?? 'none'}</p>
      <button
        type="button"
        onClick={() => {
          denied.mutate();
        }}
      >
        deny
      </button>
    </>
  );
}

function renderProvider() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Role />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  me.mockReset();
  vi.restoreAllMocks();
});

describe('role changes reach an open tab', () => {
  it('reloads the session when the tab regains focus', async () => {
    me.mockResolvedValueOnce(profile('qa_lead')).mockResolvedValue(profile('organization_admin'));
    renderProvider();
    await waitFor(() => {
      expect(screen.getByTestId('role')).toHaveTextContent('qa_lead');
    });
    const later = Date.now() + 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('role')).toHaveTextContent('organization_admin');
    });
  });

  it('reloads the session after the API answers 403', async () => {
    me.mockResolvedValueOnce(profile('organization_admin')).mockResolvedValue(profile('viewer'));
    renderProvider();
    await waitFor(() => {
      expect(screen.getByTestId('role')).toHaveTextContent('organization_admin');
    });
    const later = Date.now() + 20_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    act(() => {
      screen.getByRole('button', { name: 'deny' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('role')).toHaveTextContent('viewer');
    });
    expect(me).toHaveBeenCalledTimes(2);
  });

  it('does not reload on a focus right after the last load', async () => {
    me.mockResolvedValue(profile('tester'));
    renderProvider();
    await waitFor(() => {
      expect(screen.getByTestId('role')).toHaveTextContent('tester');
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(me).toHaveBeenCalledTimes(1);
  });
});
