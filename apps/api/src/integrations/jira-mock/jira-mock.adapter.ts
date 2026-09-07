import { Injectable } from '@nestjs/common';
import { IntegrationProviderError } from '../../errors/domain-error';
import {
  AdapterContext,
  ExternalProject,
  ExternalRef,
  HealthCheck,
  IssueFilter,
  IssueKind,
  IssuePayload,
  IssueState,
  IssueSummary,
  IssueTrackerAdapter,
  IssueTrackerCatalog,
} from '../adapter.contracts';
import {
  JIRA_MOCK_DEFAULT_PROJECT_KEY,
  JIRA_MOCK_PRIORITIES,
  JIRA_MOCK_STATUSES,
  JiraMockIssue,
  JiraMockIssueType,
  JiraMockStore,
} from './jira-mock.store';

/**
 * Non-sensitive settings the mock understands. They live in
 * `IntegrationConnection.settings` like any provider's, and they are the whole
 * reason the adapter can be driven from a test without a special code path:
 *
 *  - `projectKey`       the Jira project new issues are created in (`QA`);
 *  - `simulateFailure`  `unreachable` makes every call fail as an outage would,
 *                       `write_failure` lets reads succeed and refuses writes.
 *
 * `simulateFailure` is deliberately a setting and not an environment flag: an
 * organization in a test can be broken while the one next to it works, which is
 * exactly the situation the isolation tests need to produce.
 */
export const JIRA_MOCK_SETTING_PROJECT_KEY = 'projectKey';
export const JIRA_MOCK_SETTING_SIMULATE_FAILURE = 'simulateFailure';
export const JIRA_MOCK_FAILURE_MODES = ['unreachable', 'write_failure'] as const;
export type JiraMockFailureMode = (typeof JIRA_MOCK_FAILURE_MODES)[number];

const PROVIDER = 'Jira mock';

const ISSUE_TYPE_BY_KIND: Record<IssueKind, JiraMockIssueType> = {
  story: 'Story',
  task: 'Task',
  bug: 'Bug',
};

const KIND_BY_ISSUE_TYPE: Record<JiraMockIssueType, IssueKind> = {
  Story: 'story',
  Task: 'task',
  Bug: 'bug',
};

/** Our `Priority` enum against Jira's default scheme. */
const PRIORITY_MAP: Record<string, (typeof JIRA_MOCK_PRIORITIES)[number]> = {
  critical: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Requirement and defect states against a single Jira workflow. Both entities
 * share the four mock statuses because a real Jira project would have one
 * workflow per issue type at most, not one per source system.
 */
const STATUS_MAP: Record<string, (typeof JIRA_MOCK_STATUSES)[number]> = {
  // Requirement
  draft: 'To Do',
  in_review: 'In Review',
  approved: 'To Do',
  implemented: 'Done',
  obsolete: 'Done',
  // Defect
  open: 'To Do',
  triaged: 'To Do',
  in_progress: 'In Progress',
  resolved: 'In Review',
  closed: 'Done',
  rejected: 'Done',
  reopened: 'To Do',
};

@Injectable()
export class JiraMockIssueTrackerAdapter implements IssueTrackerAdapter {
  readonly provider = 'jira' as const;

  constructor(private readonly store: JiraMockStore) {}

  async check(context: AdapterContext): Promise<HealthCheck> {
    const checkedAt = new Date();
    if (failureMode(context) === 'unreachable') {
      return Promise.resolve({
        reachable: false,
        message: `${PROVIDER}: simulated outage (settings.simulateFailure=unreachable)`,
        checkedAt,
      });
    }

    const projectKey = projectKeyOf(context);
    if (this.store.findProject(context.organizationId, projectKey) === null) {
      return Promise.resolve({
        reachable: false,
        message: `${PROVIDER}: project "${projectKey}" does not exist. Known projects: ${this.store
          .listProjects(context.organizationId)
          .map((project) => project.key)
          .join(', ')}`,
        checkedAt,
      });
    }

    return Promise.resolve({
      reachable: true,
      message: `${PROVIDER}: reachable, issues will be created in project ${projectKey}`,
      checkedAt,
    });
  }

  /**
   * Every method is `async` on purpose: a failure surfaces as a rejected
   * promise, never as a synchronous throw, so callers handle the mock exactly
   * as they will handle a network client.
   */
  async createIssue(context: AdapterContext, payload: IssuePayload): Promise<ExternalRef> {
    this.assertWritable(context);
    const projectKey = projectKeyOf(context);
    if (this.store.findProject(context.organizationId, projectKey) === null) {
      throw new IntegrationProviderError(PROVIDER, `project "${projectKey}" does not exist`);
    }

    const issue = this.store.createIssue(context.organizationId, {
      projectKey,
      issueType: ISSUE_TYPE_BY_KIND[payload.kind],
      summary: payload.title,
      description: payload.description,
      status: STATUS_MAP[payload.state] ?? 'To Do',
      priority: PRIORITY_MAP[payload.priority] ?? 'Medium',
      labels: labelsFor(payload),
    });

    return Promise.resolve(this.toRef(context, issue));
  }

  async updateIssue(
    context: AdapterContext,
    externalId: string,
    payload: IssuePayload,
  ): Promise<ExternalRef> {
    this.assertWritable(context);

    const issue = this.store.updateIssue(context.organizationId, externalId, {
      issueType: ISSUE_TYPE_BY_KIND[payload.kind],
      summary: payload.title,
      description: payload.description,
      status: STATUS_MAP[payload.state] ?? 'To Do',
      priority: PRIORITY_MAP[payload.priority] ?? 'Medium',
      labels: labelsFor(payload),
    });
    if (issue === null) {
      throw new IntegrationProviderError(PROVIDER, `issue ${externalId} does not exist`);
    }

    return Promise.resolve(this.toRef(context, issue));
  }

  async fetchIssueState(context: AdapterContext, externalId: string): Promise<IssueState | null> {
    this.assertReachable(context);
    const issue = this.store.findIssue(context.organizationId, externalId);
    if (issue === null) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      externalId: issue.id,
      status: issue.status,
      assignee: issue.assignee?.displayName ?? null,
      url: browseUrl(context, issue.key),
    });
  }

  async getIssue(context: AdapterContext, externalId: string): Promise<IssueSummary | null> {
    this.assertReachable(context);
    const issue = this.store.findIssue(context.organizationId, externalId);
    return Promise.resolve(issue === null ? null : this.toSummary(context, issue));
  }

  async listProjects(context: AdapterContext): Promise<ExternalProject[]> {
    this.assertReachable(context);
    return Promise.resolve(
      this.store
        .listProjects(context.organizationId)
        .map((project) => ({ externalId: project.id, key: project.key, name: project.name })),
    );
  }

  async listIssues(context: AdapterContext, filter: IssueFilter): Promise<IssueSummary[]> {
    this.assertReachable(context);
    const issues = this.store.listIssues(context.organizationId, {
      ...(filter.projectKey === undefined ? {} : { projectKey: filter.projectKey }),
      ...(filter.kind === undefined ? {} : { issueType: ISSUE_TYPE_BY_KIND[filter.kind] }),
    });
    return Promise.resolve(issues.map((issue) => this.toSummary(context, issue)));
  }

  async describe(context: AdapterContext): Promise<IssueTrackerCatalog> {
    this.assertReachable(context);
    return Promise.resolve({
      priorities: [...JIRA_MOCK_PRIORITIES],
      statuses: [...JIRA_MOCK_STATUSES],
      assignees: this.store
        .listUsers(context.organizationId)
        .map((user) => ({ externalId: user.accountId, displayName: user.displayName })),
    });
  }

  private assertReachable(context: AdapterContext): void {
    if (failureMode(context) === 'unreachable') {
      throw new IntegrationProviderError(PROVIDER, 'simulated outage, the provider is unreachable');
    }
  }

  private assertWritable(context: AdapterContext): void {
    this.assertReachable(context);
    if (failureMode(context) === 'write_failure') {
      throw new IntegrationProviderError(
        PROVIDER,
        'simulated failure, the provider refused the write',
      );
    }
  }

  private toRef(context: AdapterContext, issue: JiraMockIssue): ExternalRef {
    const url = browseUrl(context, issue.key);
    return {
      provider: 'jira',
      externalId: issue.id,
      externalKey: issue.key,
      ...(url === null ? {} : { externalUrl: url }),
      metadata: {
        projectKey: issue.projectKey,
        issueType: issue.issueType,
        status: issue.status,
        priority: issue.priority,
        assignee: issue.assignee?.displayName ?? '',
      },
    };
  }

  private toSummary(context: AdapterContext, issue: JiraMockIssue): IssueSummary {
    return {
      externalId: issue.id,
      key: issue.key,
      url: browseUrl(context, issue.key),
      projectKey: issue.projectKey,
      kind: KIND_BY_ISSUE_TYPE[issue.issueType],
      title: issue.summary,
      status: issue.status,
      priority: issue.priority,
      assignee:
        issue.assignee === null
          ? null
          : { externalId: issue.assignee.accountId, displayName: issue.assignee.displayName },
      labels: issue.labels,
      updatedAt: issue.updatedAt,
    };
  }
}

function settingOf(context: AdapterContext, key: string): string | undefined {
  const value = context.settings[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function projectKeyOf(context: AdapterContext): string {
  return settingOf(context, JIRA_MOCK_SETTING_PROJECT_KEY) ?? JIRA_MOCK_DEFAULT_PROJECT_KEY;
}

function failureMode(context: AdapterContext): JiraMockFailureMode | null {
  const value = settingOf(context, JIRA_MOCK_SETTING_SIMULATE_FAILURE);
  return JIRA_MOCK_FAILURE_MODES.find((mode) => mode === value) ?? null;
}

/** `null` without a base URL: a made-up host would be a link that goes nowhere. */
function browseUrl(context: AdapterContext, key: string): string | null {
  if (context.baseUrl === null) {
    return null;
  }
  return `${context.baseUrl.replace(/\/+$/, '')}/browse/${key}`;
}

function labelsFor(payload: IssuePayload): string[] {
  const labels = [...payload.labels, 'qa-flow-hub'];
  if (payload.originKey !== null) {
    labels.push(`origin:${payload.originKey}`);
  }
  if (payload.severity !== null) {
    labels.push(`severity:${payload.severity}`);
  }
  return [...new Set(labels)];
}
