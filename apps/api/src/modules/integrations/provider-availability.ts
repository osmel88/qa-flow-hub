import { ConfigurableIntegrationProvider, IntegrationMode } from '@qa-flow-hub/shared';

/**
 * What each provider can actually do *today*, in one table.
 *
 * This exists because the alternative is the same knowledge spread across a
 * service, a controller and a React component, drifting apart phase by phase.
 * When S2-F2 lands the Jira mock, `implemented` becomes true here and nothing
 * else in this module changes.
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
    jira: {
      modes: ['mock'],
      implemented: false,
      unavailableReason:
        'The Jira mock provider is implemented in S2-F2. Jira stays on a mock until dedicated accounts exist.',
      defaultDisplayName: 'Jira',
      usesBaseUrl: true,
    },
    testrail: {
      modes: ['mock'],
      implemented: false,
      unavailableReason:
        'The TestRail mock provider is implemented in S2-F3. TestRail stays on a mock until dedicated accounts exist.',
      defaultDisplayName: 'TestRail',
      usesBaseUrl: true,
    },
    /**
     * GitHub has no mock in the plan: it is the one provider meant to be real,
     * which is also why it cannot connect yet. A real connection needs a token,
     * a token needs encryption at rest, and the credential store is S2-F4's
     * deliverable — so the configuration is editable and the connection is
     * refused, instead of accepting a token this build cannot protect.
     */
    github: {
      modes: ['real'],
      implemented: false,
      unavailableReason:
        'GitHub connects for real in S2-F4, which delivers the encrypted credential store. This build accepts no token.',
      defaultDisplayName: 'GitHub',
      usesBaseUrl: false,
    },
  };
