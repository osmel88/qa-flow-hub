import type { AuthSession, LoginInput, OrganizationSummary, RegisterInput } from '@qa-flow-hub/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { authApi } from '../api/endpoints';
import { setSessionLostHandler } from '../api/http-client';
import {
  clearSession,
  getActiveOrganizationId,
  getRefreshToken,
  setActiveOrganizationId,
  storeSession,
} from '../api/session-store';

interface AuthState {
  user: AuthSession['user'] | null;
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
  isRestoring: boolean;
}

interface AuthContextValue extends AuthState {
  activeOrganization: OrganizationSummary | null;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  selectOrganization: (organizationId: string) => void;
  refreshOrganizations: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const EMPTY: AuthState = {
  user: null,
  organizations: [],
  activeOrganizationId: null,
  isRestoring: true,
};

/**
 * Session state for the whole client.
 *
 * On boot it does not trust localStorage to describe the user: it holds a
 * refresh token and asks the API who that is. A cached user object would let a
 * revoked account keep rendering an authenticated shell until the first
 * request failed.
 */
export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AuthState>(EMPTY);

  const applySession = useCallback((session: AuthSession) => {
    storeSession(session);
    const stored = getActiveOrganizationId();
    const active =
      session.organizations.find((organization) => organization.id === stored)?.id ??
      session.organizations[0]?.id ??
      null;
    setActiveOrganizationId(active);
    setState({
      user: session.user,
      organizations: session.organizations,
      activeOrganizationId: active,
      isRestoring: false,
    });
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setState({ ...EMPTY, isRestoring: false });
  }, []);

  useEffect(() => {
    setSessionLostHandler(signOut);
  }, [signOut]);

  useEffect(() => {
    if (getRefreshToken() === null) {
      setState({ ...EMPTY, isRestoring: false });
      return;
    }

    let cancelled = false;
    void authApi
      .me()
      .then((profile) => {
        if (cancelled) {
          return;
        }
        const stored = getActiveOrganizationId();
        const active =
          profile.organizations.find((organization) => organization.id === stored)?.id ??
          profile.organizations[0]?.id ??
          null;
        setActiveOrganizationId(active);
        const { organizations, ...user } = profile;
        setState({
          user,
          organizations,
          activeOrganizationId: active,
          isRestoring: false,
        });
      })
      .catch(() => {
        if (!cancelled) {
          signOut();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      activeOrganization:
        state.organizations.find(
          (organization) => organization.id === state.activeOrganizationId,
        ) ?? null,
      login: async (input) => {
        applySession(await authApi.login(input));
      },
      register: async (input) => {
        applySession(await authApi.register(input));
      },
      logout: async () => {
        const refreshToken = getRefreshToken();
        if (refreshToken !== null) {
          // Best effort: the server may already have revoked the session, and
          // failing to reach it must not trap the user in a logged-in shell.
          await authApi.logout(refreshToken).catch(() => undefined);
        }
        signOut();
      },
      selectOrganization: (organizationId) => {
        setActiveOrganizationId(organizationId);
        setState((current) => ({ ...current, activeOrganizationId: organizationId }));
      },
      refreshOrganizations: async () => {
        const profile = await authApi.me();
        const { organizations, ...user } = profile;
        setState((current) => ({ ...current, user, organizations }));
      },
    }),
    [state, applySession, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return context;
}
