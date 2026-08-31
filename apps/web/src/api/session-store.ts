import type { AuthTokens } from '@qa-flow-hub/shared';

const ORGANIZATION_KEY = 'qafh.organizationId';

/**
 * What the browser keeps, and what it deliberately cannot keep.
 *
 * The access token lives in a module variable: short lived, gone when the tab
 * closes, and unreachable from another tab. The refresh token is never here at
 * all — the API sets it as an `HttpOnly` cookie, so no script on this page can
 * read it even if an XSS payload runs. Reloading the page still restores the
 * session, because the cookie travels with the refresh call on its own.
 *
 * The active organization is not a credential: it is a preference, and the
 * server re-checks membership on every request, so localStorage is the right
 * place for it.
 */
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function storeSession(tokens: AuthTokens): void {
  accessToken = tokens.accessToken;
}

export function clearSession(): void {
  accessToken = null;
  localStorage.removeItem(ORGANIZATION_KEY);
}

export function getActiveOrganizationId(): string | null {
  return localStorage.getItem(ORGANIZATION_KEY);
}

export function setActiveOrganizationId(organizationId: string | null): void {
  if (organizationId === null) {
    localStorage.removeItem(ORGANIZATION_KEY);
    return;
  }
  localStorage.setItem(ORGANIZATION_KEY, organizationId);
}
