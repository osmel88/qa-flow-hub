import type { AuthSession } from '@qa-flow-hub/shared';

const REFRESH_KEY = 'qafh.refreshToken';
const ORGANIZATION_KEY = 'qafh.organizationId';

/**
 * Where the two tokens live, and why they live in different places.
 *
 * The access token stays in memory: it is short lived, and a variable is gone
 * when the tab closes, so an XSS payload has to run while the tab is open to
 * see it. The refresh token goes to localStorage so that reloading the page
 * does not log the user out.
 *
 * This is a deliberate compromise, not an oversight. The safe answer is an
 * HttpOnly cookie, which the API cannot set yet because the client is a
 * different origin in development. Recorded in docs/technical-debt.md.
 */
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function storeSession(session: AuthSession): void {
  accessToken = session.accessToken;
  localStorage.setItem(REFRESH_KEY, session.refreshToken);
}

export function clearSession(): void {
  accessToken = null;
  localStorage.removeItem(REFRESH_KEY);
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
