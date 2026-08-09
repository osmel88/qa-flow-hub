import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, refreshSession } from './http-client';
import { clearSession, setAccessToken, setActiveOrganizationId, storeSession } from './session-store';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The headers a stubbed fetch was called with, asserted rather than assumed. */
function headersOfCall(call: unknown[] | undefined): Record<string, string> {
  const init = call?.[1];
  if (init === undefined) {
    throw new Error('fetch was not called with a request init');
  }
  return (init as RequestInit).headers as Record<string, string>;
}

/** The request init a stubbed fetch was called with, or a failed assertion. */
function initOfCall(call: unknown[] | undefined): RequestInit {
  const init = call?.[1];
  if (init === undefined) {
    throw new Error('fetch was not called with a request init');
  }
  return init as RequestInit;
}

beforeEach(() => {
  clearSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

describe('apiFetch', () => {
  it('sends the active organization with every tenant request', async () => {
    setAccessToken('access-1');
    setActiveOrganizationId('org_1');
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/projects');

    const headers = headersOfCall(fetchMock.mock.calls[0]);
    expect(headers['X-Organization-Id']).toBe('org_1');
    expect(headers['Authorization']).toBe('Bearer access-1');
  });

  it('leaves the organization header out where it does not belong', async () => {
    setActiveOrganizationId('org_1');
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/auth/login', { method: 'POST', body: {}, withoutOrganization: true });

    const headers = headersOfCall(fetchMock.mock.calls[0]);
    expect(headers['X-Organization-Id']).toBeUndefined();
  });

  it('refreshes once for concurrent 401s instead of racing the token rotation', async () => {
    storeSession({ accessToken: 'expired', refreshToken: null, expiresIn: 900 });

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse({ accessToken: 'fresh', refreshToken: null, expiresIn: 900 });
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return headers['Authorization'] === 'Bearer fresh'
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([apiFetch('/projects'), apiFetch('/defects'), apiFetch('/requirements')]);

    const refreshCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/auth/refresh'),
    );
    // Rotation treats a replayed refresh token as theft and kills the family:
    // three parallel refreshes would log the user out for doing nothing wrong.
    expect(refreshCalls).toHaveLength(1);
  });

  it('raises a typed error carrying the code the API sent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'FORBIDDEN', message: 'Not allowed' } }, 403),
      ),
    );

    await expect(apiFetch('/defects')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(apiFetch('/defects')).rejects.toBeInstanceOf(ApiError);
  });

  it('never keeps a refresh token where script can read it', async () => {
    storeSession({ accessToken: 'access-1', refreshToken: null, expiresIn: 900 });

    // The cookie is the credential; anything in localStorage would be readable
    // by an XSS payload for the next 30 days.
    expect(JSON.stringify(localStorage)).not.toContain('access-1');
    expect(localStorage.getItem('qafh.refreshToken')).toBeNull();
  });

  it('sends the refresh cookie and no body token when rotating', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ accessToken: 'fresh', refreshToken: null, expiresIn: 900 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await refreshSession();

    const init = initOfCall(fetchMock.mock.calls[0]);
    expect(init.credentials).toBe('include');
    expect(String(init.body)).not.toContain('refreshToken');
  });
});
