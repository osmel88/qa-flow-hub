import type {
  AuthSession,
  LoginInput,
  MfaChallengeView,
  MfaVerifyInput,
  OrganizationSummary,
  RegisterInput,
} from '@qa-flow-hub/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { authApi, mfaApi } from '../api/endpoints';
import { refreshSession, setSessionLostHandler } from '../api/http-client';
import {
  clearSession,
  getActiveOrganizationId,
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
  /** Resolves to the challenge when the account needs a second factor. */
  login: (input: LoginInput) => Promise<MfaChallengeView | null>;
  verifyMfa: (input: MfaVerifyInput) => Promise<void>;
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
 * On boot there is no access token in memory and the refresh token is a cookie
 * this code cannot read, so restoring a session means asking the API: rotate the
 * cookie, then fetch the profile. Nothing about the user is cached — a cached
 * user object would let a revoked account keep rendering an authenticated shell
 * until the first request failed.
 */
export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AuthState>(EMPTY);
  const queryClient = useQueryClient();

  /**
   * Every cached response belongs to one tenant and one user. Changing either
   * drops the whole cache — in-flight requests included — so no screen can
   * render, even for a frame, data fetched under the previous identity.
   */
  const forgetTenantData = useCallback(() => {
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);

  const applySession = useCallback((session: AuthSession) => {
    forgetTenantData();
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
  }, [forgetTenantData]);

  const signOut = useCallback(() => {
    clearSession();
    forgetTenantData();
    setState({ ...EMPTY, isRestoring: false });
  }, [forgetTenantData]);

  useEffect(() => {
    setSessionLostHandler(signOut);
  }, [signOut]);

  useEffect(() => {
    let cancelled = false;
    void refreshSession()
      .then((restored) => (restored ? authApi.me() : null))
      .then((profile) => {
        if (cancelled) {
          return;
        }
        if (profile === null) {
          setState({ ...EMPTY, isRestoring: false });
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
        const result = await authApi.login(input);
        if ('mfaRequired' in result) {
          return result;
        }
        applySession(result);
        return null;
      },
      verifyMfa: async (input) => {
        applySession(await mfaApi.verify(input));
      },
      register: async (input) => {
        applySession(await authApi.register(input));
      },
      logout: async () => {
        // Best effort: the server may already have revoked the session, and
        // failing to reach it must not trap the user in a logged-in shell.
        await authApi.logout().catch(() => undefined);
        signOut();
      },
      selectOrganization: (organizationId) => {
        if (organizationId === state.activeOrganizationId) {
          return;
        }
        // The header is switched first so that any refetch triggered by the
        // cleared cache already speaks for the new organization.
        setActiveOrganizationId(organizationId);
        forgetTenantData();
        setState((current) => ({ ...current, activeOrganizationId: organizationId }));
      },
      refreshOrganizations: async () => {
        const profile = await authApi.me();
        const { organizations, ...user } = profile;
        setState((current) => ({ ...current, user, organizations }));
      },
    }),
    [state, applySession, signOut, forgetTenantData],
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
