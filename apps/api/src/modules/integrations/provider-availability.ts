import { ConfigurableIntegrationProvider, IntegrationMode } from '@qa-flow-hub/shared';

/**
 * What each provider can actually do *today*, in one table.
 *
 * This exists because the alternative is the same knowledge spread across a
 * service, a controller and a React component, drifting apart phase by phase.
 * When S2-F2 landed the Jira mock, `implemented` became true here and nothing
 * else in this module changed.
 *
 * `unavailableReason` is sent to the client verbatim: a disabled button whose
 * tooltip says nothing produces a support ticket, and the honest answer ("this
 * arrives in a later phase") is shorter than the conversation.
 */
export interface ProviderAvailability {
  modes: IntegrationMode[];
  /** Whether a provider implementation exists that could answer a request. */
  implemented: boolean;
  unavailableReason: string | null;
  defaultDisplayName: string;
  /** Whether a base URL is meaningful for this provider. */
  usesBaseUrl: boolean;
}

export const PROVIDER_AVAILABILITY: Record<ConfigurableIntegrationProvider, ProviderAvailability> =
  {
    /**
     * Mock only, and implemented: the simulated Jira in `integrations/jira-mock`
     * answers every call. `real` stays out until dedicated accounts exist.
     */
    jira: {
      modes: ['mock'],
      implemented: true,
      unavailableReason: null,
      defaultDisplayName: 'Jira',
      usesBaseUrl: true,
    },
    /** Mock only, and implemented since S2-F3 by `integrations/testrail-mock`. */
    testrail: {
      modes: ['mock'],
      implemented: true,
      unavailableReason: null,
      defaultDisplayName: 'TestRail',
      usesBaseUrl: true,
    },
    /**
     * Mock only, and implemented since S2-F4 by `integrations/github-mock`.
     * `real` stays out of the list on purpose: a real connection needs a token,
     * a token needs encryption at rest, and that credential store belongs to
     * the post-S2 production stage. Until then this build accepts no token.
     */
    github: {
      modes: ['mock'],
      implemented: true,
      unavailableReason: null,
      defaultDisplayName: 'GitHub',
      usesBaseUrl: false,
    },
  };
