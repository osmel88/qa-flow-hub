import { Injectable } from '@nestjs/common';

/**
 * The state of the simulated Jira, one tenant per organization.
 *
 * Process memory, on purpose. A mock that lived in PostgreSQL would need its
 * own tables, migrations and RLS policies for data that exists only so the rest
 * of qa-flow-hub can be exercised; the price would be paid on every future
 * schema change of a product that will never ship those tables. The trade is
 * that a restart forgets every issue the mock created — `ExternalReference`
 * rows survive, and a sync against a forgotten issue recreates it. That is
 * recorded in docs/technical-debt.md as the limit of this phase.
 *
 * Isolation is by construction: every method takes an `organizationId` and
 * resolves its tenant first. There is no operation that reaches across tenants
 * because there is no method that takes two.
 *
 * Determinism: two organizations start from byte-identical catalogs, ids are
 * allocated from a counter and keys from a per-project counter, so a test that
 * creates one issue can assert on `QA-4` and not on a random string.
 */

export type JiraMockIssueType = 'Story' | 'Task' | 'Bug';

export interface JiraMockProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraMockUser {
  accountId: string;
  displayName: string;
}

export interface JiraMockIssue {
  id: string;
  key: string;
  projectKey: string;
  issueType: JiraMockIssueType;
  summary: string;
  description: string | null;
  status: string;
  priority: string;
  assignee: JiraMockUser | null;
  labels: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface JiraMockIssueInput {
  projectKey: string;
  issueType: JiraMockIssueType;
  summary: string;
  description: string | null;
  status: string;
  priority: string;
  labels: string[];
}

export const JIRA_MOCK_PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'] as const;
export const JIRA_MOCK_STATUSES = ['To Do', 'In Progress', 'In Review', 'Done'] as const;

export const JIRA_MOCK_PROJECTS: readonly JiraMockProject[] = [
  { id: '10000', key: 'QA', name: 'Quality Assurance' },
  { id: '10001', key: 'WEB', name: 'Web Platform' },
];

export const JIRA_MOCK_USERS: readonly JiraMockUser[] = [
  { accountId: 'mock-user-ada', displayName: 'Ada Lovelace' },
  { accountId: 'mock-user-grace', displayName: 'Grace Hopper' },
  { accountId: 'mock-user-margaret', displayName: 'Margaret Hamilton' },
];

export const JIRA_MOCK_DEFAULT_PROJECT_KEY = 'QA';

/** The first issue id the mock allocates; Jira's own ids are numeric strings. */
const FIRST_ISSUE_ID = 10100;

/** A fixed instant so seeded issues compare equal across tenants and test runs. */
const SEED_INSTANT = new Date('2026-01-05T09:00:00.000Z');

interface SeedIssue {
  projectKey: string;
  issueType: JiraMockIssueType;
  summary: string;
  status: string;
  priority: string;
  assignee: number | null;
  labels: string[];
}

/**
 * Pre-existing issues, so listing shows something before the first sync and a
 * test can check that our issues land next to Jira's rather than in a void.
 */
const SEED_ISSUES: readonly SeedIssue[] = [
  {
    projectKey: 'QA',
    issueType: 'Story',
    summary: 'Regression suite for the checkout flow',
    status: 'In Progress',
    priority: 'High',
    assignee: 0,
    labels: ['seed'],
  },
  {
    projectKey: 'QA',
    issueType: 'Bug',
    summary: 'Login form accepts an empty password',
    status: 'To Do',
    priority: 'Highest',
    assignee: 1,
    labels: ['seed', 'security'],
  },
  {
    projectKey: 'WEB',
    issueType: 'Task',
    summary: 'Publish the accessibility statement',
    status: 'Done',
    priority: 'Low',
    assignee: null,
    labels: ['seed'],
  },
];

class JiraMockTenant {
  readonly issues = new Map<string, JiraMockIssue>();
  private nextIssueId = FIRST_ISSUE_ID;
  private readonly keyCounters = new Map<string, number>();

  constructor() {
    for (const seed of SEED_ISSUES) {
      const created = this.create(
        {
          projectKey: seed.projectKey,
          issueType: seed.issueType,
          summary: seed.summary,
          description: null,
          status: seed.status,
          priority: seed.priority,
          labels: seed.labels,
        },
        SEED_INSTANT,
      );
      created.assignee = seed.assignee === null ? null : (JIRA_MOCK_USERS[seed.assignee] ?? null);
    }
  }

  create(input: JiraMockIssueInput, now: Date): JiraMockIssue {
    const sequence = (this.keyCounters.get(input.projectKey) ?? 0) + 1;
    this.keyCounters.set(input.projectKey, sequence);

    const issue: JiraMockIssue = {
      id: String(this.nextIssueId++),
      key: `${input.projectKey}-${sequence}`,
      projectKey: input.projectKey,
      issueType: input.issueType,
      summary: input.summary,
      description: input.description,
      status: input.status,
      priority: input.priority,
      assignee: null,
      labels: [...input.labels],
      createdAt: now,
      updatedAt: now,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }
}

@Injectable()
export class JiraMockStore {
  private readonly tenants = new Map<string, JiraMockTenant>();

  listProjects(_organizationId: string): JiraMockProject[] {
    return JIRA_MOCK_PROJECTS.map((project) => ({ ...project }));
  }

  findProject(_organizationId: string, key: string): JiraMockProject | null {
    return JIRA_MOCK_PROJECTS.find((project) => project.key === key) ?? null;
  }

  listUsers(_organizationId: string): JiraMockUser[] {
    return JIRA_MOCK_USERS.map((user) => ({ ...user }));
  }

  listIssues(
    organizationId: string,
    filter: { projectKey?: string; issueType?: JiraMockIssueType } = {},
  ): JiraMockIssue[] {
    return [...this.tenant(organizationId).issues.values()]
      .filter((issue) => filter.projectKey === undefined || issue.projectKey === filter.projectKey)
      .filter((issue) => filter.issueType === undefined || issue.issueType === filter.issueType)
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(cloneIssue);
  }

  findIssue(organizationId: string, id: string): JiraMockIssue | null {
    const issue = this.tenant(organizationId).issues.get(id);
    return issue === undefined ? null : cloneIssue(issue);
  }

  createIssue(organizationId: string, input: JiraMockIssueInput, now = new Date()): JiraMockIssue {
    return cloneIssue(this.tenant(organizationId).create(input, now));
  }

  /**
   * Returns `null` for an unknown id instead of throwing, so the adapter can
   * decide what "unknown" means — for a real Jira it would be a 404 from the
   * API, and the sync service treats both the same way.
   */
  updateIssue(
    organizationId: string,
    id: string,
    changes: Partial<Omit<JiraMockIssueInput, 'projectKey'>>,
    now = new Date(),
  ): JiraMockIssue | null {
    const issue = this.tenant(organizationId).issues.get(id);
    if (issue === undefined) {
      return null;
    }
    if (changes.issueType !== undefined) issue.issueType = changes.issueType;
    if (changes.summary !== undefined) issue.summary = changes.summary;
    if (changes.description !== undefined) issue.description = changes.description;
    if (changes.status !== undefined) issue.status = changes.status;
    if (changes.priority !== undefined) issue.priority = changes.priority;
    if (changes.labels !== undefined) issue.labels = [...changes.labels];
    issue.updatedAt = now;
    return cloneIssue(issue);
  }

  /** Test hook: forgets one organization, as a restart would forget all of them. */
  reset(organizationId?: string): void {
    if (organizationId === undefined) {
      this.tenants.clear();
    } else {
      this.tenants.delete(organizationId);
    }
  }

  private tenant(organizationId: string): JiraMockTenant {
    let tenant = this.tenants.get(organizationId);
    if (tenant === undefined) {
      tenant = new JiraMockTenant();
      this.tenants.set(organizationId, tenant);
    }
    return tenant;
  }
}

function cloneIssue(issue: JiraMockIssue): JiraMockIssue {
  return {
    ...issue,
    assignee: issue.assignee === null ? null : { ...issue.assignee },
    labels: [...issue.labels],
  };
}
