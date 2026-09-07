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
  'jira' | 'testrail' | 'github' | 'github_actions' | 'playwright' | 'custom';

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
  baseUrl: string | null;
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

/**
 * Which of our entities an issue stands for. The adapter turns this into the
 * provider's own vocabulary (Story, Bug, …); the host never learns that
 * vocabulary exists.
 */
export type IssueKind = 'story' | 'task' | 'bug';

export interface IssuePayload {
  kind: IssueKind;
  title: string;
  description: string | null;
  /** Our own values (`critical`, `in_review`…); mapping them is the adapter's job. */
  severity: string | null;
  priority: string;
  state: string;
  /** Read-only context the provider may render: keys, not internal ids. */
  originKey: string | null;
  labels: string[];
}

export interface IssueState {
  externalId: string;
  status: string;
  assignee: string | null;
  url: string | null;
}

export interface IssueAssignee {
  externalId: string;
  displayName: string;
}

/** One row of a provider's issue list, in provider vocabulary. */
export interface IssueSummary {
  externalId: string;
  key: string | null;
  url: string | null;
  projectKey: string | null;
  kind: IssueKind;
  title: string;
  status: string;
  priority: string;
  assignee: IssueAssignee | null;
  labels: string[];
  updatedAt: Date;
}

export interface ExternalProject {
  externalId: string;
  key: string;
  name: string;
}

/** The values a provider accepts, so a client can offer them without guessing. */
export interface IssueTrackerCatalog {
  priorities: string[];
  statuses: string[];
  assignees: IssueAssignee[];
}

export interface IssueFilter {
  projectKey?: string;
  kind?: IssueKind;
}

/** Jira, Linear, GitHub Issues. */
export interface IssueTrackerAdapter {
  readonly provider: IntegrationProviderName;
  check(context: AdapterContext): Promise<HealthCheck>;
  createIssue(context: AdapterContext, payload: IssuePayload): Promise<ExternalRef>;
  /**
   * Re-sends the whole payload rather than a diff: the provider owns the issue
   * and reconciles, and a diff protocol would need both sides to agree on a
   * last-seen version this host does not keep.
   */
  updateIssue(
    context: AdapterContext,
    externalId: string,
    payload: IssuePayload,
  ): Promise<ExternalRef>;
  /** Pull, not push: the provider is the source of truth for its own status. */
  fetchIssueState(context: AdapterContext, externalId: string): Promise<IssueState | null>;
  getIssue(context: AdapterContext, externalId: string): Promise<IssueSummary | null>;
  listProjects(context: AdapterContext): Promise<ExternalProject[]>;
  listIssues(context: AdapterContext, filter: IssueFilter): Promise<IssueSummary[]>;
  describe(context: AdapterContext): Promise<IssueTrackerCatalog>;
}

export interface ImportedCase {
  externalId: string;
  key: string | null;
  title: string;
  steps: Array<{ action: string; expectedResult: string | null }>;
}

/** Our `TestSuite`, as a provider needs to see it. */
export interface SuitePayload {
  projectKey: string | null;
  name: string;
  description: string | null;
}

export interface CaseStepPayload {
  action: string;
  expectedResult: string | null;
}

/**
 * Our `TestCase`. `suiteExternalId` is the provider's id for the suite the
 * case belongs to — the host resolves it through `ExternalReference` before
 * calling, so the adapter never sees an internal id.
 */
export interface CasePayload {
  suiteExternalId: string;
  /** Provider sections are created on demand from this name; `null` is the suite root. */
  sectionName: string | null;
  title: string;
  /** Our own values (`regression`, `critical`…); mapping them is the adapter's job. */
  type: string;
  priority: string;
  preconditions: string | null;
  expectedResult: string | null;
  steps: CaseStepPayload[];
  originKey: string | null;
  labels: string[];
}

export interface RunPayload {
  suiteExternalId: string;
  name: string;
  description: string | null;
  /** Provider ids of the cases in the run; the host resolved each through its reference. */
  caseExternalIds: string[];
  state: string;
}

export interface ResultPayload {
  runExternalId: string;
  caseExternalId: string;
  /** One of our `TestResultStatus` values. */
  status: string;
  comment: string | null;
  elapsedSeconds: number | null;
}

export interface ExternalSuite {
  externalId: string;
  projectKey: string | null;
  name: string;
  description: string | null;
  url: string | null;
  caseCount: number;
  updatedAt: Date;
}

export interface ExternalCase {
  externalId: string;
  key: string | null;
  url: string | null;
  suiteExternalId: string;
  sectionName: string | null;
  title: string;
  type: string;
  priority: string;
  stepCount: number;
  updatedAt: Date;
}

export interface ExternalRun {
  externalId: string;
  url: string | null;
  suiteExternalId: string;
  name: string;
  status: string;
  caseCount: number;
  /** Provider status name → how many tests in the run carry it. */
  statusCounts: Record<string, number>;
  updatedAt: Date;
}

export interface ExternalResult {
  externalId: string;
  runExternalId: string;
  caseExternalId: string;
  status: string;
  comment: string | null;
  elapsedSeconds: number | null;
  recordedAt: Date;
}

/** The values a test management provider accepts. */
export interface TestManagementCatalog {
  statuses: string[];
  priorities: string[];
  caseTypes: string[];
}

/**
 * TestRail, Xray, Zephyr.
 *
 * Suites, cases, runs and results are four operations each rather than one
 * generic `push(entity)` because the providers really are that shaped: a case
 * cannot exist outside a suite, a result cannot exist outside a run, and a
 * generic method would only move those rules into a `switch`. Every `fetch*`
 * returns `null` for an id the provider no longer knows, so the host can decide
 * to recreate.
 */
export interface TestManagementAdapter {
  readonly provider: IntegrationProviderName;
  check(context: AdapterContext): Promise<HealthCheck>;
  describe(context: AdapterContext): Promise<TestManagementCatalog>;
  listProjects(context: AdapterContext): Promise<ExternalProject[]>;
  listSuites(context: AdapterContext, projectKey?: string): Promise<ExternalSuite[]>;
  listCases(context: AdapterContext, suiteExternalId: string): Promise<ExternalCase[]>;
  listRuns(context: AdapterContext, projectKey?: string): Promise<ExternalRun[]>;
  importCases(context: AdapterContext, suiteExternalId: string): Promise<ImportedCase[]>;

  createSuite(context: AdapterContext, payload: SuitePayload): Promise<ExternalRef>;
  updateSuite(
    context: AdapterContext,
    externalId: string,
    payload: SuitePayload,
  ): Promise<ExternalRef>;
  fetchSuite(context: AdapterContext, externalId: string): Promise<ExternalSuite | null>;

  createCase(context: AdapterContext, payload: CasePayload): Promise<ExternalRef>;
  updateCase(
    context: AdapterContext,
    externalId: string,
    payload: CasePayload,
  ): Promise<ExternalRef>;
  fetchCase(context: AdapterContext, externalId: string): Promise<ExternalCase | null>;

  createRun(context: AdapterContext, payload: RunPayload): Promise<ExternalRef>;
  updateRun(context: AdapterContext, externalId: string, payload: RunPayload): Promise<ExternalRef>;
  fetchRun(context: AdapterContext, externalId: string): Promise<ExternalRun | null>;

  /**
   * Results are append-only in every provider this port targets, so there is
   * no `updateResult`: re-syncing a result the provider already has is a no-op
   * that returns the existing reference.
   */
  addResult(context: AdapterContext, payload: ResultPayload): Promise<ExternalRef>;
  fetchResult(context: AdapterContext, externalId: string): Promise<ExternalResult | null>;
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
