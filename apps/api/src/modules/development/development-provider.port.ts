import type { CreateDevelopmentArtifactInput, DevelopmentProvider } from '@qa-flow-hub/shared';

/**
 * What a future GitHub/GitLab/Azure DevOps adapter will implement (S5-F1).
 * Adapters map provider events to these records and hand them to
 * `DevelopmentService`, keyed by (provider, externalId); the domain never
 * imports a provider SDK. No adapter is registered yet: everything is local.
 */
export interface DevelopmentActivityRecord extends Omit<
  CreateDevelopmentArtifactInput,
  'projectId' | 'workItemIds' | 'provider'
> {
  externalId: string;
  /** Work item keys mentioned by the activity (e.g. "WEB-W-12" in a branch). */
  workItemKeys: string[];
}

export interface DevelopmentActivitySource {
  readonly provider: Exclude<DevelopmentProvider, 'local'>;
  /** Activity changed since `since` in a provider-side repository. */
  fetch(repository: string, since: Date | null): Promise<DevelopmentActivityRecord[]>;
}
