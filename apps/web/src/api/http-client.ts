import type { ApiErrorResponse, AuthSession } from '@qa-flow-hub/shared';
import {
  clearSession,
  getAccessToken,
  getActiveOrganizationId,
  getRefreshToken,
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

async function refreshSession(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (refreshToken === null) {
    return false;
  }

  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!response.ok) {
    clearSession();
    return false;
  }

  storeSession((await response.json()) as AuthSession);
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
  signal?: AbortSignal;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const accessToken = getAccessToken();
  const organizationId = getActiveOrganizationId();

  return fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
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

  if (response.status === 401 && getRefreshToken() !== null) {
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
