import { Injectable } from '@nestjs/common';

/**
 * The state of the simulated TestRail, one tenant per organization.
 *
 * Same trade as the Jira mock: process memory, byte-identical seed per tenant,
 * ids from counters. What is TestRail-shaped here is the object graph, because
 * a mock that flattened it would not exercise the code that matters:
 *
 *   project ─┬─ suite ─┬─ section ─── case
 *            │         └─ run ─── test (one per case in the run) ─── result*
 *            └─ …
 *
 * A "test" is TestRail's name for a case inside a run; results hang off tests,
 * not off cases, which is why `addResult` takes a run and a case and finds the
 * test between them. Results are append-only, as in the real product.
 *
 * Ids are numeric strings and each entity type has its own counter, exactly
 * like TestRail (`S1`, `C1`, `R1`, `T1` are all different objects).
 */

export interface TestRailMockProject {
  id: string;
  name: string;
}

export interface TestRailMockSuite {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TestRailMockSection {
  id: string;
  suiteId: string;
  parentId: string | null;
  name: string;
}

export interface TestRailMockStep {
  content: string;
  expected: string | null;
}

export interface TestRailMockCase {
  id: string;
  suiteId: string;
  sectionId: string;
  title: string;
  typeId: number;
  priorityId: number;
  preconditions: string | null;
  expected: string | null;
  steps: TestRailMockStep[];
  refs: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TestRailMockCaseInput {
  suiteId: string;
  sectionId: string;
  title: string;
  typeId: number;
  priorityId: number;
  preconditions: string | null;
  expected: string | null;
  steps: TestRailMockStep[];
  refs: string | null;
}

export interface TestRailMockRun {
  id: string;
  projectId: string;
  suiteId: string;
  name: string;
  description: string | null;
  isCompleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TestRailMockTest {
  id: string;
  runId: string;
  caseId: string;
  statusId: number;
}

export interface TestRailMockResult {
  id: string;
  testId: string;
  statusId: number;
  comment: string | null;
  elapsedSeconds: number | null;
  createdAt: Date;
}

export interface TestRailMockStatus {
  id: number;
  name: string;
  label: string;
}

export interface TestRailMockPriority {
  id: number;
  name: string;
}

export interface TestRailMockCaseType {
  id: number;
  name: string;
}

/** TestRail's five system statuses plus one custom status a team would add for skipped tests. */
export const TESTRAIL_MOCK_STATUSES: readonly TestRailMockStatus[] = [
  { id: 1, name: 'passed', label: 'Passed' },
  { id: 2, name: 'blocked', label: 'Blocked' },
  { id: 3, name: 'untested', label: 'Untested' },
  { id: 4, name: 'retest', label: 'Retest' },
  { id: 5, name: 'failed', label: 'Failed' },
  { id: 6, name: 'custom_status1', label: 'Skipped' },
];

export const TESTRAIL_MOCK_PRIORITIES: readonly TestRailMockPriority[] = [
  { id: 1, name: 'Low' },
  { id: 2, name: 'Medium' },
  { id: 3, name: 'High' },
  { id: 4, name: 'Critical' },
];

export const TESTRAIL_MOCK_CASE_TYPES: readonly TestRailMockCaseType[] = [
  { id: 1, name: 'Acceptance' },
  { id: 2, name: 'Accessibility' },
  { id: 3, name: 'Automated' },
  { id: 4, name: 'Compatibility' },
  { id: 5, name: 'Destructive' },
  { id: 6, name: 'Functional' },
  { id: 7, name: 'Other' },
  { id: 8, name: 'Performance' },
  { id: 9, name: 'Regression' },
  { id: 10, name: 'Security' },
  { id: 11, name: 'Smoke & Sanity' },
  { id: 12, name: 'Usability' },
];

export const TESTRAIL_MOCK_PROJECTS: readonly TestRailMockProject[] = [
  { id: '1', name: 'Quality Assurance' },
  { id: '2', name: 'Web Platform' },
];

export const TESTRAIL_MOCK_DEFAULT_PROJECT_ID = '1';

/** The untested status every new test starts in. */
export const TESTRAIL_UNTESTED_STATUS_ID = 3;

const SEED_INSTANT = new Date('2026-01-05T09:00:00.000Z');

class Counter {
  private next = 1;
  take(): string {
    return String(this.next++);
  }
}

/**
 * The pre-existing catalog every tenant starts from: one suite with one
 * section and two cases, one run over both cases with a single passed result.
 * It consumes S1, section 1, C1–C2, R1, T1–T2 and result 1, so the first suite
 * a sync creates is always `S2` and the first case `C3`.
 */
class TestRailMockTenant {
  readonly suites = new Map<string, TestRailMockSuite>();
  readonly sections = new Map<string, TestRailMockSection>();
  readonly cases = new Map<string, TestRailMockCase>();
  readonly runs = new Map<string, TestRailMockRun>();
  readonly tests = new Map<string, TestRailMockTest>();
  readonly results = new Map<string, TestRailMockResult>();

  private readonly suiteIds = new Counter();
  private readonly sectionIds = new Counter();
  private readonly caseIds = new Counter();
  private readonly runIds = new Counter();
  private readonly testIds = new Counter();
  private readonly resultIds = new Counter();

  constructor() {
    const suite = this.createSuite('1', 'Master', 'Seeded regression suite', SEED_INSTANT);
    const section = this.createSection(suite.id, null, 'Smoke');
    const login = this.createCase(
      {
        suiteId: suite.id,
        sectionId: section.id,
        title: 'User can sign in with valid credentials',
        typeId: 11,
        priorityId: 4,
        preconditions: 'An active account exists',
        expected: 'The dashboard is shown',
        steps: [
          { content: 'Open the sign-in page', expected: 'Form is visible' },
          { content: 'Submit valid credentials', expected: 'Redirected to the dashboard' },
        ],
        refs: null,
      },
      SEED_INSTANT,
    );
    const logout = this.createCase(
      {
        suiteId: suite.id,
        sectionId: section.id,
        title: 'User can sign out',
        typeId: 6,
        priorityId: 2,
        preconditions: null,
        expected: 'The session is closed',
        steps: [],
        refs: null,
      },
      SEED_INSTANT,
    );
    const run = this.createRun(
      { projectId: '1', suiteId: suite.id, name: 'Nightly smoke', description: null },
      [login.id, logout.id],
      SEED_INSTANT,
    );
    const test = this.findTest(run.id, login.id);
    if (test !== null) {
      this.addResult(test, 1, 'Seeded result', 12, SEED_INSTANT);
    }
  }

  createSuite(
    projectId: string,
    name: string,
    description: string | null,
    now: Date,
  ): TestRailMockSuite {
    const suite: TestRailMockSuite = {
      id: this.suiteIds.take(),
      projectId,
      name,
      description,
      createdAt: now,
      updatedAt: now,
    };
    this.suites.set(suite.id, suite);
    return suite;
  }

  createSection(suiteId: string, parentId: string | null, name: string): TestRailMockSection {
    const section: TestRailMockSection = { id: this.sectionIds.take(), suiteId, parentId, name };
    this.sections.set(section.id, section);
    return section;
  }

  createCase(input: TestRailMockCaseInput, now: Date): TestRailMockCase {
    const testCase: TestRailMockCase = {
      id: this.caseIds.take(),
      ...input,
      steps: input.steps.map((step) => ({ ...step })),
      createdAt: now,
      updatedAt: now,
    };
    this.cases.set(testCase.id, testCase);
    return testCase;
  }

  createRun(
    input: Pick<TestRailMockRun, 'projectId' | 'suiteId' | 'name' | 'description'>,
    caseIds: string[],
    now: Date,
  ): TestRailMockRun {
    const run: TestRailMockRun = {
      id: this.runIds.take(),
      ...input,
      isCompleted: false,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    this.syncTests(run, caseIds);
    return run;
  }

  /** Adds a test for every new case and keeps the existing ones (and their results). */
  syncTests(run: TestRailMockRun, caseIds: string[]): void {
    const present = new Set(
      [...this.tests.values()].filter((test) => test.runId === run.id).map((test) => test.caseId),
    );
    for (const caseId of caseIds) {
      if (present.has(caseId)) continue;
      const test: TestRailMockTest = {
        id: this.testIds.take(),
        runId: run.id,
        caseId,
        statusId: TESTRAIL_UNTESTED_STATUS_ID,
      };
      this.tests.set(test.id, test);
    }
  }

  findTest(runId: string, caseId: string): TestRailMockTest | null {
    for (const test of this.tests.values()) {
      if (test.runId === runId && test.caseId === caseId) return test;
    }
    return null;
  }

  addResult(
    test: TestRailMockTest,
    statusId: number,
    comment: string | null,
    elapsedSeconds: number | null,
    now: Date,
  ): TestRailMockResult {
    const result: TestRailMockResult = {
      id: this.resultIds.take(),
      testId: test.id,
      statusId,
      comment,
      elapsedSeconds,
      createdAt: now,
    };
    this.results.set(result.id, result);
    test.statusId = statusId;
    return result;
  }
}

@Injectable()
export class TestRailMockStore {
  private readonly tenants = new Map<string, TestRailMockTenant>();

  listProjects(_organizationId: string): TestRailMockProject[] {
    return TESTRAIL_MOCK_PROJECTS.map((project) => ({ ...project }));
  }

  findProject(_organizationId: string, id: string): TestRailMockProject | null {
    return TESTRAIL_MOCK_PROJECTS.find((project) => project.id === id) ?? null;
  }

  // -- suites ---------------------------------------------------------------

  listSuites(organizationId: string, projectId?: string): TestRailMockSuite[] {
    return [...this.tenant(organizationId).suites.values()]
      .filter((suite) => projectId === undefined || suite.projectId === projectId)
      .sort(byNumericId)
      .map((suite) => ({ ...suite }));
  }

  findSuite(organizationId: string, id: string): TestRailMockSuite | null {
    const suite = this.tenant(organizationId).suites.get(id);
    return suite === undefined ? null : { ...suite };
  }

  createSuite(
    organizationId: string,
    input: { projectId: string; name: string; description: string | null },
    now = new Date(),
  ): TestRailMockSuite {
    const tenant = this.tenant(organizationId);
    const suite = tenant.createSuite(input.projectId, input.name, input.description, now);
    // Every TestRail suite has at least one section; cases cannot live at the root.
    tenant.createSection(suite.id, null, 'All Test Cases');
    return { ...suite };
  }

  updateSuite(
    organizationId: string,
    id: string,
    changes: { name?: string; description?: string | null },
    now = new Date(),
  ): TestRailMockSuite | null {
    const suite = this.tenant(organizationId).suites.get(id);
    if (suite === undefined) return null;
    if (changes.name !== undefined) suite.name = changes.name;
    if (changes.description !== undefined) suite.description = changes.description;
    suite.updatedAt = now;
    return { ...suite };
  }

  countCases(organizationId: string, suiteId: string): number {
    let count = 0;
    for (const testCase of this.tenant(organizationId).cases.values()) {
      if (testCase.suiteId === suiteId) count += 1;
    }
    return count;
  }

  // -- sections -------------------------------------------------------------

  listSections(organizationId: string, suiteId: string): TestRailMockSection[] {
    return [...this.tenant(organizationId).sections.values()]
      .filter((section) => section.suiteId === suiteId)
      .sort(byNumericId)
      .map((section) => ({ ...section }));
  }

  findSection(organizationId: string, id: string): TestRailMockSection | null {
    const section = this.tenant(organizationId).sections.get(id);
    return section === undefined ? null : { ...section };
  }

  /**
   * The root section of a suite, or the section with the given name, created
   * on first use. Sections are matched by name because our `TestSection` has no
   * external reference of its own: they are a grouping, not a tracked entity.
   */
  ensureSection(organizationId: string, suiteId: string, name: string | null): TestRailMockSection {
    const tenant = this.tenant(organizationId);
    const sections = this.listSections(organizationId, suiteId);
    const root = sections.find((section) => section.parentId === null);
    if (root === undefined) {
      throw new Error(`suite ${suiteId} has no root section`);
    }
    if (name === null) return root;
    const existing = sections.find((section) => section.name === name);
    if (existing !== undefined) return existing;
    return { ...tenant.createSection(suiteId, root.id, name) };
  }

  // -- cases ----------------------------------------------------------------

  listCases(organizationId: string, suiteId: string): TestRailMockCase[] {
    return [...this.tenant(organizationId).cases.values()]
      .filter((testCase) => testCase.suiteId === suiteId)
      .sort(byNumericId)
      .map(cloneCase);
  }

  findCase(organizationId: string, id: string): TestRailMockCase | null {
    const testCase = this.tenant(organizationId).cases.get(id);
    return testCase === undefined ? null : cloneCase(testCase);
  }

  createCase(
    organizationId: string,
    input: TestRailMockCaseInput,
    now = new Date(),
  ): TestRailMockCase {
    return cloneCase(this.tenant(organizationId).createCase(input, now));
  }

  updateCase(
    organizationId: string,
    id: string,
    changes: Partial<Omit<TestRailMockCaseInput, 'suiteId'>>,
    now = new Date(),
  ): TestRailMockCase | null {
    const testCase = this.tenant(organizationId).cases.get(id);
    if (testCase === undefined) return null;
    if (changes.sectionId !== undefined) testCase.sectionId = changes.sectionId;
    if (changes.title !== undefined) testCase.title = changes.title;
    if (changes.typeId !== undefined) testCase.typeId = changes.typeId;
    if (changes.priorityId !== undefined) testCase.priorityId = changes.priorityId;
    if (changes.preconditions !== undefined) testCase.preconditions = changes.preconditions;
    if (changes.expected !== undefined) testCase.expected = changes.expected;
    if (changes.steps !== undefined) testCase.steps = changes.steps.map((step) => ({ ...step }));
    if (changes.refs !== undefined) testCase.refs = changes.refs;
    testCase.updatedAt = now;
    return cloneCase(testCase);
  }

  // -- runs -----------------------------------------------------------------

  listRuns(organizationId: string, projectId?: string): TestRailMockRun[] {
    return [...this.tenant(organizationId).runs.values()]
      .filter((run) => projectId === undefined || run.projectId === projectId)
      .sort(byNumericId)
      .map((run) => ({ ...run }));
  }

  findRun(organizationId: string, id: string): TestRailMockRun | null {
    const run = this.tenant(organizationId).runs.get(id);
    return run === undefined ? null : { ...run };
  }

  createRun(
    organizationId: string,
    input: { projectId: string; suiteId: string; name: string; description: string | null },
    caseIds: string[],
    now = new Date(),
  ): TestRailMockRun {
    return { ...this.tenant(organizationId).createRun(input, caseIds, now) };
  }

  updateRun(
    organizationId: string,
    id: string,
    changes: {
      name?: string;
      description?: string | null;
      isCompleted?: boolean;
      caseIds?: string[];
    },
    now = new Date(),
  ): TestRailMockRun | null {
    const tenant = this.tenant(organizationId);
    const run = tenant.runs.get(id);
    if (run === undefined) return null;
    if (changes.name !== undefined) run.name = changes.name;
    if (changes.description !== undefined) run.description = changes.description;
    if (changes.isCompleted !== undefined) run.isCompleted = changes.isCompleted;
    if (changes.caseIds !== undefined) tenant.syncTests(run, changes.caseIds);
    run.updatedAt = now;
    return { ...run };
  }

  listTests(organizationId: string, runId: string): TestRailMockTest[] {
    return [...this.tenant(organizationId).tests.values()]
      .filter((test) => test.runId === runId)
      .sort(byNumericId)
      .map((test) => ({ ...test }));
  }

  findTest(organizationId: string, runId: string, caseId: string): TestRailMockTest | null {
    const test = this.tenant(organizationId).findTest(runId, caseId);
    return test === null ? null : { ...test };
  }

  findTestById(organizationId: string, id: string): TestRailMockTest | null {
    const test = this.tenant(organizationId).tests.get(id);
    return test === undefined ? null : { ...test };
  }

  // -- results --------------------------------------------------------------

  /** `null` when the run has no test for the case: TestRail rejects results for cases outside the run. */
  addResult(
    organizationId: string,
    input: {
      runId: string;
      caseId: string;
      statusId: number;
      comment: string | null;
      elapsedSeconds: number | null;
    },
    now = new Date(),
  ): TestRailMockResult | null {
    const tenant = this.tenant(organizationId);
    const test = tenant.findTest(input.runId, input.caseId);
    if (test === null) return null;
    return { ...tenant.addResult(test, input.statusId, input.comment, input.elapsedSeconds, now) };
  }

  findResult(organizationId: string, id: string): TestRailMockResult | null {
    const result = this.tenant(organizationId).results.get(id);
    return result === undefined ? null : { ...result };
  }

  listResults(organizationId: string, testId: string): TestRailMockResult[] {
    return [...this.tenant(organizationId).results.values()]
      .filter((result) => result.testId === testId)
      .sort(byNumericId)
      .map((result) => ({ ...result }));
  }

  /** Test hook: forgets one organization, as a restart would forget all of them. */
  reset(organizationId?: string): void {
    if (organizationId === undefined) {
      this.tenants.clear();
    } else {
      this.tenants.delete(organizationId);
    }
  }

  private tenant(organizationId: string): TestRailMockTenant {
    let tenant = this.tenants.get(organizationId);
    if (tenant === undefined) {
      tenant = new TestRailMockTenant();
      this.tenants.set(organizationId, tenant);
    }
    return tenant;
  }
}

function byNumericId(a: { id: string }, b: { id: string }): number {
  return Number(a.id) - Number(b.id);
}

function cloneCase(testCase: TestRailMockCase): TestRailMockCase {
  return { ...testCase, steps: testCase.steps.map((step) => ({ ...step })) };
}
