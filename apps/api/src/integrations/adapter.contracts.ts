/**
 * The seams for Jira, TestRail, GitHub and CI providers.
 *
 * Nothing here talks to the network in the MVP. The contracts exist now, and
 * not when the first integration is built, for one reason: a port designed
 * after the first adapter always ends up shaped like that adapter. Writing the
 * interface against the domain first is what keeps the second provider from
 * being a rewrite.
 *
 * Every method is expressed in terms of qa-flow-hub's own entities. No Jira
 * issue type, no TestRail suite id, no GitHub run number leaks past this file:
 * the mapping lives inside each adapter, and the outside world sees an
 * `ExternalReference`.
 */

export type IntegrationProviderName =
  | 'jira'
  | 'testrail'
  | 'github'
  | 'github_actions'
  | 'playwright'
  | 'custom';

/** What the caller gets back after pushing something to a provider. */
export interface ExternalRef {
  provider: IntegrationProviderName;
  externalId: string;
  externalKey?: string;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface AdapterContext {
  organizationId: string;
  connectionId: string;
  /**
   * A reference to a secret, never the secret. Resolving it is the host's job,
   * so an adapter can be unit tested without credentials and a log line can
   * never contain a token.
   */
  secretRef: string | null;
  settings: Record<string, unknown>;
}

export interface HealthCheck {
  reachable: boolean;
  message: string;
  checkedAt: Date;
}

export interface IssuePayload {
  title: string;
  description: string | null;
  severity: string;
  priority: string;
  /** Read-only context the provider may render: keys, not internal ids. */
  originKey: string | null;
}

export interface IssueState {
  externalId: string;
  status: string;
  assignee: string | null;
  url: string | null;
}

/** Jira, Linear, GitHub Issues. */
export interface IssueTrackerAdapter {
  readonly provider: IntegrationProviderName;
  check(context: AdapterContext): Promise<HealthCheck>;
  createIssue(context: AdapterContext, payload: IssuePayload): Promise<ExternalRef>;
  /** Pull, not push: the provider is the source of truth for its own status. */
  fetchIssueState(context: AdapterContext, externalId: string): Promise<IssueState | null>;
}

export interface ImportedCase {
  externalId: string;
  key: string | null;
  title: string;
  steps: Array<{ action: string; expectedResult: string | null }>;
}

/** TestRail, Xray, Zephyr. */
export interface TestManagementAdapter {
  readonly provider: IntegrationProviderName;
  check(context: AdapterContext): Promise<HealthCheck>;
  importCases(context: AdapterContext, externalSuiteId: string): Promise<ImportedCase[]>;
  exportRun(context: AdapterContext, testRunId: string): Promise<ExternalRef>;
}

export interface AutomatedResult {
  externalId: string;
  /** The automated test's own name; mapping it to a case is the host's job. */
  testIdentifier: string;
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
  durationMs: number | null;
  message: string | null;
  executedAt: Date;
}

/** GitHub Actions, Playwright reporters, any CI. */
export interface AutomationProviderAdapter {
  readonly provider: IntegrationProviderName;
  check(context: AdapterContext): Promise<HealthCheck>;
  /**
   * Pulls results for one CI execution. Ingestion is a pull rather than a
   * webhook push in the MVP because a pull needs no public endpoint, no
   * signature verification and no replay protection — three things that must
   * be right before any of them can be exposed.
   */
  fetchResults(context: AdapterContext, externalRunId: string): Promise<AutomatedResult[]>;
}

/**
 * The seam for transactional email. Invitations currently return their token in
 * the HTTP response (see docs/technical-debt.md) precisely because nothing
 * implements this yet; when a provider is added, the invitation service changes
 * one call and stops returning the token.
 */
export interface EmailAdapter {
  readonly provider: string;
  send(message: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ accepted: boolean; messageId: string | null }>;
}
