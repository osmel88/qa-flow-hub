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
  // Tabs share the refresh cookie but not `refreshInFlight`. Two tabs rotating
  // the same token at once would make the later one look like a replay, so the
  // rotation is serialised across every tab of the origin.
  if ('locks' in navigator) {
    return navigator.locks.request(REFRESH_LOCK, rotateRefreshToken);
  }
  return rotateRefreshToken();
}

const REFRESH_LOCK = 'qa-flow-hub:refresh';

async function rotateRefreshToken(): Promise<boolean> {
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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
      // A FormData body sets its own multipart Content-Type, boundary included;
      // naming it here would break the upload.
      ...(options.body === undefined || options.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...(accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` }),
      ...(organizationId === null || options.withoutOrganization === true
        ? {}
        : { 'X-Organization-Id': organizationId }),
    },
    ...(options.body === undefined
      ? {}
      : { body: options.body instanceof FormData ? options.body : JSON.stringify(options.body) }),
  });
}

/**
 * The authenticated fetch for bytes (evidence downloads). Same token, same
 * organization header and same refresh-on-401 as `apiFetch`, but the body
 * comes back as a `Blob` for the caller to save or display.
 */
export async function apiFetchBlob(
  path: string,
  options: Pick<RequestOptions, 'signal'> = {},
): Promise<{ blob: Blob; fileName: string | null }> {
  let response = await send(path, options);
  if (response.status === 401) {
    if (await ensureRefresh()) {
      response = await send(path, options);
    } else {
      onSessionLost();
    }
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    const error = (payload as ApiErrorResponse | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return {
    blob: await response.blob(),
    fileName: fileNameFrom(response.headers.get('Content-Disposition')),
  };
}

function fileNameFrom(disposition: string | null): string | null {
  if (disposition === null) {
    return null;
  }
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // fall through to the plain name
    }
  }
  return /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
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
