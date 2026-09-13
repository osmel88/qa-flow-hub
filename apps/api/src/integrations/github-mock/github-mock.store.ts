import { Injectable } from '@nestjs/common';
import { WorkflowRunConclusion, WorkflowRunStatus } from '../adapter.contracts';

/**
 * The state of the simulated GitHub, one tenant per organization.
 *
 * Third mock, same trade: process memory, byte-identical seed per tenant. What
 * is different is that this one is **read-only**: qa-flow-hub never creates a
 * repository or a workflow run, it observes what CI produced. So there are no
 * counters and no `create*` — the seed *is* the data, and a test that needs a
 * different history changes the seed, not the store.
 *
 *   repository ─┬─ branch
 *               └─ workflow ─── workflow run ─┬─ job ─── step
 *                                             ├─ artifact
 *                                             └─ automated result (one per Playwright test)
 *
 * Automated results are what the Playwright reporter would have published for
 * the run. Tests carry `@C-<n>` tags in their title, the convention by which a
 * result finds its qa-flow-hub case: `C-1` is "case 1 of whichever project the
 * internal run belongs to". The mock knows nothing about projects.
 */

export interface GitHubMockRepository {
  id: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  updatedAt: Date;
}

export interface GitHubMockBranch {
  repositoryId: string;
  name: string;
  headSha: string;
  isProtected: boolean;
}

export interface GitHubMockWorkflow {
  id: string;
  repositoryId: string;
  name: string;
  path: string;
  state: 'active' | 'disabled';
}

export interface GitHubMockWorkflowRun {
  id: string;
  repositoryId: string;
  workflowId: string;
  runNumber: number;
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion | null;
  event: string;
  headBranch: string;
  headSha: string;
  commitMessage: string;
  actor: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GitHubMockStep {
  name: string;
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion | null;
}

export interface GitHubMockJob {
  id: string;
  runId: string;
  name: string;
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion | null;
  startedAt: Date | null;
  completedAt: Date | null;
  steps: GitHubMockStep[];
}

export interface GitHubMockArtifact {
  id: string;
  runId: string;
  name: string;
  kind: 'playwright_report' | 'junit' | 'other';
  sizeInBytes: number;
  expired: boolean;
}

export type GitHubMockResultStatus = 'passed' | 'failed' | 'skipped' | 'blocked';

export interface GitHubMockAutomatedResult {
  id: string;
  runId: string;
  file: string;
  /** The Playwright title, tags included, as a reporter would print it. */
  title: string;
  project: string;
  status: GitHubMockResultStatus;
  durationMs: number | null;
  message: string | null;
  executedAt: Date;
}

interface GitHubMockTenant {
  repositories: Map<string, GitHubMockRepository>;
  branches: GitHubMockBranch[];
  workflows: Map<string, GitHubMockWorkflow>;
  runs: Map<string, GitHubMockWorkflowRun>;
  jobs: GitHubMockJob[];
  artifacts: GitHubMockArtifact[];
  results: GitHubMockAutomatedResult[];
}

export const GITHUB_MOCK_DEFAULT_REPOSITORY = 'acme/web-checkout';

/** Fixed timestamps: a seed that depended on `Date.now()` would not be a seed. */
const T0 = new Date('2026-08-24T08:00:00.000Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const SHA_MAIN = '4f1c2a9e7b3d5c8f0a1b2c3d4e5f60718293a4b5';
const SHA_FEATURE = 'b7e2d4c6a8f0e1d3c5b7a9f1e3d5c7b9a1f3e5d7';
const SHA_MAIN_OLDER = '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b';
const SHA_GATEWAY = 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';

const REPOSITORIES: readonly GitHubMockRepository[] = [
  {
    id: '1',
    fullName: GITHUB_MOCK_DEFAULT_REPOSITORY,
    defaultBranch: 'main',
    isPrivate: true,
    updatedAt: at(120),
  },
  {
    id: '2',
    fullName: 'acme/api-gateway',
    defaultBranch: 'main',
    isPrivate: true,
    updatedAt: at(60),
  },
];

const BRANCHES: readonly GitHubMockBranch[] = [
  { repositoryId: '1', name: 'main', headSha: SHA_MAIN, isProtected: true },
  { repositoryId: '1', name: 'feature/checkout-retry', headSha: SHA_FEATURE, isProtected: false },
  { repositoryId: '2', name: 'main', headSha: SHA_GATEWAY, isProtected: true },
];

const WORKFLOWS: readonly GitHubMockWorkflow[] = [
  {
    id: '1',
    repositoryId: '1',
    name: 'Playwright E2E',
    path: '.github/workflows/e2e.yml',
    state: 'active',
  },
  { id: '2', repositoryId: '1', name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  { id: '3', repositoryId: '2', name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
];

/** Run ids start at 1001 and step by one, in creation order, like GitHub's own. */
const RUNS: readonly GitHubMockWorkflowRun[] = [
  {
    id: '1001',
    repositoryId: '1',
    workflowId: '1',
    runNumber: 41,
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    headBranch: 'main',
    headSha: SHA_MAIN,
    commitMessage: 'feat(checkout): retry payment on gateway timeout',
    actor: 'dev-one',
    createdAt: at(0),
    updatedAt: at(9),
  },
  {
    id: '1002',
    repositoryId: '1',
    workflowId: '1',
    runNumber: 42,
    status: 'completed',
    conclusion: 'failure',
    event: 'pull_request',
    headBranch: 'feature/checkout-retry',
    headSha: SHA_FEATURE,
    commitMessage: 'wip: tighten expiry validation',
    actor: 'dev-two',
    createdAt: at(30),
    updatedAt: at(41),
  },
  {
    id: '1003',
    repositoryId: '1',
    workflowId: '1',
    runNumber: 43,
    status: 'in_progress',
    conclusion: null,
    event: 'push',
    headBranch: 'main',
    headSha: SHA_MAIN,
    commitMessage: 'chore: bump playwright',
    actor: 'dev-one',
    createdAt: at(110),
    updatedAt: at(112),
  },
  {
    id: '1004',
    repositoryId: '1',
    workflowId: '2',
    runNumber: 118,
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    headBranch: 'main',
    headSha: SHA_MAIN_OLDER,
    commitMessage: 'refactor: extract price formatter',
    actor: 'dev-one',
    createdAt: at(-60),
    updatedAt: at(-52),
  },
  {
    id: '1005',
    repositoryId: '2',
    workflowId: '3',
    runNumber: 7,
    status: 'completed',
    conclusion: 'cancelled',
    event: 'schedule',
    headBranch: 'main',
    headSha: SHA_GATEWAY,
    commitMessage: 'ci: nightly',
    actor: 'github-actions[bot]',
    createdAt: at(-120),
    updatedAt: at(-118),
  },
];

const JOBS: readonly GitHubMockJob[] = [
  {
    id: '5001',
    runId: '1001',
    name: 'e2e (chromium)',
    status: 'completed',
    conclusion: 'success',
    startedAt: at(1),
    completedAt: at(9),
    steps: [
      { name: 'Checkout', status: 'completed', conclusion: 'success' },
      { name: 'Install dependencies', status: 'completed', conclusion: 'success' },
      { name: 'Run Playwright', status: 'completed', conclusion: 'success' },
      { name: 'Upload report', status: 'completed', conclusion: 'success' },
    ],
  },
  {
    id: '5002',
    runId: '1002',
    name: 'e2e (chromium)',
    status: 'completed',
    conclusion: 'failure',
    startedAt: at(31),
    completedAt: at(41),
    steps: [
      { name: 'Checkout', status: 'completed', conclusion: 'success' },
      { name: 'Install dependencies', status: 'completed', conclusion: 'success' },
      { name: 'Run Playwright', status: 'completed', conclusion: 'failure' },
      { name: 'Upload report', status: 'completed', conclusion: 'success' },
    ],
  },
  {
    id: '5003',
    runId: '1003',
    name: 'e2e (chromium)',
    status: 'in_progress',
    conclusion: null,
    startedAt: at(111),
    completedAt: null,
    steps: [
      { name: 'Checkout', status: 'completed', conclusion: 'success' },
      { name: 'Install dependencies', status: 'completed', conclusion: 'success' },
      { name: 'Run Playwright', status: 'in_progress', conclusion: null },
      { name: 'Upload report', status: 'queued', conclusion: null },
    ],
  },
  {
    id: '5004',
    runId: '1004',
    name: 'lint-and-test',
    status: 'completed',
    conclusion: 'success',
    startedAt: at(-59),
    completedAt: at(-52),
    steps: [
      { name: 'Checkout', status: 'completed', conclusion: 'success' },
      { name: 'Lint', status: 'completed', conclusion: 'success' },
      { name: 'Unit tests', status: 'completed', conclusion: 'success' },
    ],
  },
  {
    id: '5005',
    runId: '1005',
    name: 'lint-and-test',
    status: 'completed',
    conclusion: 'cancelled',
    startedAt: at(-119),
    completedAt: at(-118),
    steps: [{ name: 'Checkout', status: 'completed', conclusion: 'cancelled' }],
  },
];

const ARTIFACTS: readonly GitHubMockArtifact[] = [
  {
    id: '9001',
    runId: '1001',
    name: 'playwright-report',
    kind: 'playwright_report',
    sizeInBytes: 1_482_113,
    expired: false,
  },
  {
    id: '9002',
    runId: '1001',
    name: 'test-results',
    kind: 'other',
    sizeInBytes: 20_480,
    expired: false,
  },
  {
    id: '9003',
    runId: '1002',
    name: 'playwright-report',
    kind: 'playwright_report',
    sizeInBytes: 2_907_554,
    expired: false,
  },
  {
    id: '9004',
    runId: '1004',
    name: 'junit-results',
    kind: 'junit',
    sizeInBytes: 8_192,
    expired: true,
  },
];

/**
 * One Playwright test each. Result ids are `<run>-<ordinal>`, so the same test
 * in two runs has two ids — results are facts about an execution, not about a
 * test. `C-1`…`C-3` are the cases a run of the internal project may contain;
 * the smoke test carries no tag and is what the import reports as unmatched.
 */
const RESULTS: readonly GitHubMockAutomatedResult[] = [
  {
    id: '1001-1',
    runId: '1001',
    file: 'e2e/checkout.spec.ts',
    title: 'checkout › pays with a valid card @C-1',
    project: 'chromium',
    status: 'passed',
    durationMs: 1320,
    message: null,
    executedAt: at(6),
  },
  {
    id: '1001-2',
    runId: '1001',
    file: 'e2e/checkout.spec.ts',
    title: 'checkout › rejects an expired card @C-2',
    project: 'chromium',
    status: 'passed',
    durationMs: 980,
    message: null,
    executedAt: at(6),
  },
  {
    id: '1001-3',
    runId: '1001',
    file: 'e2e/cart.spec.ts',
    title: 'cart › removes an item @C-3',
    project: 'chromium',
    status: 'skipped',
    durationMs: 0,
    message: 'test.skip(): flaky on CI, see #482',
    executedAt: at(7),
  },
  {
    id: '1001-4',
    runId: '1001',
    file: 'e2e/smoke.spec.ts',
    title: 'smoke › home page loads',
    project: 'chromium',
    status: 'passed',
    durationMs: 410,
    message: null,
    executedAt: at(7),
  },
  {
    id: '1002-1',
    runId: '1002',
    file: 'e2e/checkout.spec.ts',
    title: 'checkout › pays with a valid card @C-1',
    project: 'chromium',
    status: 'passed',
    durationMs: 1410,
    message: null,
    executedAt: at(38),
  },
  {
    id: '1002-2',
    runId: '1002',
    file: 'e2e/checkout.spec.ts',
    title: 'checkout › rejects an expired card @C-2',
    project: 'chromium',
    status: 'failed',
    durationMs: 5230,
    message:
      'expect(locator).toHaveText(expected)\n\nExpected string: "Card expired"\nReceived string: "Payment failed"',
    executedAt: at(38),
  },
  {
    id: '1002-3',
    runId: '1002',
    file: 'e2e/cart.spec.ts',
    title: 'cart › removes an item @C-3',
    project: 'chromium',
    status: 'passed',
    durationMs: 760,
    message: null,
    executedAt: at(39),
  },
  {
    id: '1002-4',
    runId: '1002',
    file: 'e2e/smoke.spec.ts',
    title: 'smoke › home page loads',
    project: 'chromium',
    status: 'failed',
    durationMs: 30_000,
    message: 'Test timeout of 30000ms exceeded.',
    executedAt: at(40),
  },
];

@Injectable()
export class GitHubMockStore {
  private readonly tenants = new Map<string, GitHubMockTenant>();

  listRepositories(organizationId: string): GitHubMockRepository[] {
    return [...this.tenant(organizationId).repositories.values()];
  }

  /** Accepts the id or the `owner/name`, which is what a user types in settings. */
  findRepository(organizationId: string, idOrFullName: string): GitHubMockRepository | null {
    const tenant = this.tenant(organizationId);
    const byId = tenant.repositories.get(idOrFullName);
    if (byId !== undefined) {
      return byId;
    }
    const wanted = idOrFullName.toLowerCase();
    for (const repository of tenant.repositories.values()) {
      if (repository.fullName.toLowerCase() === wanted) {
        return repository;
      }
    }
    return null;
  }

  listBranches(organizationId: string, repositoryId: string): GitHubMockBranch[] {
    return this.tenant(organizationId).branches.filter(
      (branch) => branch.repositoryId === repositoryId,
    );
  }

  listWorkflows(organizationId: string, repositoryId: string): GitHubMockWorkflow[] {
    return [...this.tenant(organizationId).workflows.values()].filter(
      (workflow) => workflow.repositoryId === repositoryId,
    );
  }

  findWorkflow(organizationId: string, workflowId: string): GitHubMockWorkflow | null {
    return this.tenant(organizationId).workflows.get(workflowId) ?? null;
  }

  /** Newest first, as the Actions tab lists them. */
  listWorkflowRuns(
    organizationId: string,
    repositoryId: string,
    workflowId?: string,
  ): GitHubMockWorkflowRun[] {
    return [...this.tenant(organizationId).runs.values()]
      .filter(
        (run) =>
          run.repositoryId === repositoryId &&
          (workflowId === undefined || run.workflowId === workflowId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  findWorkflowRun(
    organizationId: string,
    repositoryId: string,
    runId: string,
  ): GitHubMockWorkflowRun | null {
    const run = this.tenant(organizationId).runs.get(runId);
    return run !== undefined && run.repositoryId === repositoryId ? run : null;
  }

  listJobs(organizationId: string, runId: string): GitHubMockJob[] {
    return this.tenant(organizationId).jobs.filter((job) => job.runId === runId);
  }

  listArtifacts(organizationId: string, runId: string): GitHubMockArtifact[] {
    return this.tenant(organizationId).artifacts.filter((artifact) => artifact.runId === runId);
  }

  listResults(organizationId: string, runId: string): GitHubMockAutomatedResult[] {
    return this.tenant(organizationId).results.filter((result) => result.runId === runId);
  }

  findResult(organizationId: string, resultId: string): GitHubMockAutomatedResult | null {
    return this.tenant(organizationId).results.find((result) => result.id === resultId) ?? null;
  }

  /**
   * Marks a seeded run as gone, the one mutation a read-only provider still
   * needs simulating: GitHub deletes workflow runs after their retention period
   * (or when a user asks), and an `ExternalReference` pointing at one must be
   * detectable. Tests only.
   */
  forgetWorkflowRun(organizationId: string, runId: string): void {
    const tenant = this.tenant(organizationId);
    tenant.runs.delete(runId);
    tenant.jobs = tenant.jobs.filter((job) => job.runId !== runId);
    tenant.artifacts = tenant.artifacts.filter((artifact) => artifact.runId !== runId);
    tenant.results = tenant.results.filter((result) => result.runId !== runId);
  }

  reset(organizationId?: string): void {
    if (organizationId === undefined) {
      this.tenants.clear();
    } else {
      this.tenants.delete(organizationId);
    }
  }

  private tenant(organizationId: string): GitHubMockTenant {
    let tenant = this.tenants.get(organizationId);
    if (tenant === undefined) {
      tenant = seed();
      this.tenants.set(organizationId, tenant);
    }
    return tenant;
  }
}

function seed(): GitHubMockTenant {
  return {
    repositories: new Map(REPOSITORIES.map((repository) => [repository.id, { ...repository }])),
    branches: BRANCHES.map((branch) => ({ ...branch })),
    workflows: new Map(WORKFLOWS.map((workflow) => [workflow.id, { ...workflow }])),
    runs: new Map(RUNS.map((run) => [run.id, { ...run }])),
    jobs: JOBS.map((job) => ({ ...job, steps: job.steps.map((step) => ({ ...step })) })),
    artifacts: ARTIFACTS.map((artifact) => ({ ...artifact })),
    results: RESULTS.map((result) => ({ ...result })),
  };
}
