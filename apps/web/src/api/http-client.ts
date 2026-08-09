import type { ApiErrorResponse, AuthTokens } from '@qa-flow-hub/shared';
import {
  clearSession,
  getAccessToken,
  getActiveOrganizationId,
  storeSession,
} from './session-store';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const API_BASE = '/api/v1';

/** Set by the auth provider so a dead session can unwind the UI. */
let onSessionLost: () => void = () => {};

export function setSessionLostHandler(handler: () => void): void {
  onSessionLost = handler;
}

/**
 * A single in-flight refresh, shared by every caller.
 *
 * Without it, a screen firing five queries at once would send five refreshes
 * with the same token; rotation would accept the first and treat the rest as
 * replays, revoking the whole family and logging the user out for doing
 * nothing wrong.
 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * No token is sent: the refresh credential is an `HttpOnly` cookie the browser
 * attaches itself. `credentials: 'include'` is what makes it travel, and a 401
 * here is the only way the client learns it has no session.
 */
export async function refreshSession(): Promise<boolean> {
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });

  if (!response.ok) {
    clearSession();
    return false;
  }

  storeSession((await response.json()) as AuthTokens);
  return true;
}

function ensureRefresh(): Promise<boolean> {
  refreshInFlight ??= refreshSession().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Endpoints outside a tenant (login, listing my organizations). */
  withoutOrganization?: boolean;
  /** Login and register: a 401 there means bad credentials, not a stale token. */
  skipRefresh?: boolean;
  signal?: AbortSignal;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const accessToken = getAccessToken();
  const organizationId = getActiveOrganizationId();

  return fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    // The auth endpoints need the refresh cookie; the rest ignore it.
    credentials: 'include',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    headers: {
      Accept: 'application/json',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` }),
      ...(organizationId === null || options.withoutOrganization === true
        ? {}
        : { 'X-Organization-Id': organizationId }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/**
 * One fetch wrapper for the whole client: JSON in, JSON out, a typed
 * `ApiError` carrying the server's code, and a transparent retry after
 * refreshing an expired access token.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(path, options);

  // Whether a refresh cookie exists is no longer knowable from script, so the
  // 401 itself is the trigger and the refresh call decides.
  if (response.status === 401 && options.skipRefresh !== true) {
    if (await ensureRefresh()) {
      response = await send(path, options);
    } else {
      onSessionLost();
    }
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const error = (payload as ApiErrorResponse | undefined)?.error;
    if (response.status === 401) {
      onSessionLost();
    }
    throw new ApiError(
      response.status,
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return payload as T;
}

/** Drops undefined values so an unset filter never becomes `?status=undefined`. */
export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const serialized = search.toString();
  return serialized === '' ? '' : `?${serialized}`;
}
