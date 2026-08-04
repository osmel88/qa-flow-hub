import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector } from './utils/workspace';

describe('defects and traceability', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let workspace: TestWorkspace;
  let suiteId: string;

  const request = injector(() => app);

  const asOwner = (payload?: object) => ({
    ...(payload === undefined ? {} : { payload }),
    token: workspace.owner.accessToken,
    organizationId: workspace.organizationId,
  });

  const createRequirement = async (title = 'The user can pay') =>
    (
      await request(
        'POST',
        '/api/v1/requirements',
        asOwner({ projectId: workspace.projectId, title }),
      )
    ).json();

  const createCase = async (title = 'Pay with a valid card') =>
    (await request('POST', '/api/v1/test-cases', asOwner({ suiteId, title }))).json();

  const createDefect = (payload: object = {}) =>
    request(
      'POST',
      '/api/v1/defects',
      asOwner({ projectId: workspace.projectId, title: 'Payment button does nothing', ...payload }),
    );

  const link = (payload: object) => request('POST', '/api/v1/traceability/links', asOwner(payload));

  /** Runs a case and records one result, returning the result id. */
  const executeCase = async (testCaseId: string, status: string): Promise<string> => {
    const run = await request(
      'POST',
      '/api/v1/test-runs',
      asOwner({
        projectId: workspace.projectId,
        name: `Run for ${testCaseId}`,
        selection: { testCaseIds: [testCaseId] },
      }),
    );
    const runId = run.json().id;
    const runCaseId = (
      await request('GET', `/api/v1/test-runs/${runId}/cases`, asOwner())
    ).json().data[0].id;

    const result = await request(
      'POST',
      `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
      asOwner({ status }),
    );
    return result.json().id;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    workspace = await createWorkspace(app);
    suiteId = (
      await request(
        'POST',
        '/api/v1/test-suites',
        asOwner({ projectId: workspace.projectId, name: 'Checkout' }),
      )
    ).json().id;
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('reporting', () => {
    it('numbers defects with their own project counter', async () => {
      const first = await createDefect();
      const second = await createDefect({ title: 'Total is wrong' });

      expect([first.json().key, second.json().key]).toEqual(['WEB-D-1', 'WEB-D-2']);
      expect(first.json()).toMatchObject({ status: 'open', severity: 'major' });
    });

    it('derives run and case from the failed result instead of trusting the client', async () => {
      const testCase = await createCase();
      const resultId = await executeCase(testCase.id, 'failed');

      const defect = await createDefect({ testResultId: resultId });

      expect(defect.json().testCaseId).toBe(testCase.id);
      expect(defect.json().testRunId).not.toBeNull();
      // The origin is also a link, so it shows up in traceability views.
      const links = await request(
        'GET',
        `/api/v1/traceability/links?entityType=defect&entityId=${defect.json().id}`,
        asOwner(),
      );
      expect(links.json()).toContainEqual(
        expect.objectContaining({ targetType: 'test_result', linkType: 'caused_by' }),
      );
    });

    it('refuses to raise a defect from a passing result', async () => {
      const testCase = await createCase();
      const resultId = await executeCase(testCase.id, 'passed');

      const response = await createDefect({ testResultId: resultId });

      expect(response.statusCode).toBe(400);
      expect(await prisma.defect.count()).toBe(0);
    });

    it('does not consume the counter when creation fails', async () => {
      await createDefect();
      const rejected = await createDefect({ testResultId: 'does-not-exist' });
      expect(rejected.statusCode).toBe(404);

      expect((await createDefect({ title: 'Second real defect' })).json().key).toBe('WEB-D-2');
    });

    it('refuses an assignee from outside the organization', async () => {
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });

      const response = await createDefect({ assigneeId: stranger.owner.userId });

      expect(response.statusCode).toBe(400);
    });

    it('lets a tester report but not a viewer', async () => {
      const tester = await workspace.addMember('tester');
      const viewer = await workspace.addMember('viewer');
      const payload = { projectId: workspace.projectId, title: 'Found while executing' };

      const reported = await request('POST', '/api/v1/defects', {
        payload,
        token: tester.accessToken,
        organizationId: workspace.organizationId,
      });
      const refused = await request('POST', '/api/v1/defects', {
        payload,
        token: viewer.accessToken,
        organizationId: workspace.organizationId,
      });

      expect([reported.statusCode, refused.statusCode]).toEqual([201, 403]);
    });
  });

  describe('workflow', () => {
    const move = (id: string, status: string) =>
      request('POST', `/api/v1/defects/${id}/status`, asOwner({ status }));

    it('walks the happy path and stamps the dates', async () => {
      const id = (await createDefect()).json().id;

      await move(id, 'triaged');
      await move(id, 'in_progress');
      const resolved = await move(id, 'resolved');
      const closed = await move(id, 'closed');

      expect(resolved.json().resolvedAt).not.toBeNull();
      expect(closed.json()).toMatchObject({ status: 'closed' });
      expect(closed.json().closedAt).not.toBeNull();
    });

    it('clears the dates when a defect comes back', async () => {
      const id = (await createDefect()).json().id;
      await move(id, 'in_progress');
      await move(id, 'resolved');
      await move(id, 'closed');

      const reopened = await move(id, 'reopened');

      expect(reopened.json()).toMatchObject({
        status: 'reopened',
        resolvedAt: null,
        closedAt: null,
      });
    });

    it('rejects an illegal jump and repeating the current status', async () => {
      const id = (await createDefect()).json().id;

      const jump = await move(id, 'closed');
      const repeat = await move(id, 'open');

      expect([jump.statusCode, repeat.statusCode]).toEqual([409, 409]);
      expect(jump.json().error.message).toContain('cannot move from open to closed');
    });

    it('filters by outstanding status', async () => {
      const open = (await createDefect({ title: 'Still broken' })).json().id;
      const done = (await createDefect({ title: 'Already fixed' })).json().id;
      await move(done, 'rejected');

      const outstanding = await request(
        'GET',
        `/api/v1/defects?projectId=${workspace.projectId}&open=true`,
        asOwner(),
      );

      expect(outstanding.json().data.map((defect: { id: string }) => defect.id)).toEqual([open]);
    });
  });

  describe('links', () => {
    it('links a requirement to a case and refuses the duplicate', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      const payload = {
        sourceType: 'requirement',
        sourceId: requirement.id,
        targetType: 'test_case',
        targetId: testCase.id,
        linkType: 'verifies',
      };

      const created = await link(payload);
      const duplicate = await link(payload);

      expect(created.statusCode).toBe(201);
      expect(duplicate.statusCode).toBe(409);
    });

    it('rejects linking an entity to itself', async () => {
      const requirement = await createRequirement();

      const response = await link({
        sourceType: 'requirement',
        sourceId: requirement.id,
        targetType: 'requirement',
        targetId: requirement.id,
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects an id from another organization', async () => {
      const requirement = await createRequirement();
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });
      const foreignCase = await request('POST', '/api/v1/test-suites', {
        payload: { projectId: stranger.projectId, name: 'Checkout' },
        token: stranger.owner.accessToken,
        organizationId: stranger.organizationId,
      });

      const response = await link({
        sourceType: 'requirement',
        sourceId: requirement.id,
        targetType: 'test_case',
        targetId: foreignCase.json().id,
      });

      expect(response.statusCode).toBe(400);
      expect(await prisma.traceabilityLink.count()).toBe(0);
    });

    it('finds a link from either end', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      await link({
        sourceType: 'requirement',
        sourceId: requirement.id,
        targetType: 'test_case',
        targetId: testCase.id,
        linkType: 'verifies',
      });

      const fromCase = await request(
        'GET',
        `/api/v1/traceability/links?entityType=test_case&entityId=${testCase.id}`,
        asOwner(),
      );

      expect(fromCase.json()).toHaveLength(1);
    });
  });

  describe('matrix', () => {
    const matrix = async (query = '') =>
      (
        await request(
          'GET',
          `/api/v1/traceability/matrix?projectId=${workspace.projectId}${query}`,
          asOwner(),
        )
      ).json();

    it('reports an uncovered requirement', async () => {
      await createRequirement();

      const result = await matrix();

      expect(result.summary).toMatchObject({
        requirements: 1,
        covered: 0,
        verified: 0,
        coverage: 0,
        uncovered: 1,
      });
      expect(result.rows[0]).toMatchObject({ covered: false, verified: false, cases: [] });
    });

    it('separates covered from verified', async () => {
      const written = await createRequirement('Covered but never executed');
      const executed = await createRequirement('Covered and passing');
      const untestedCase = await createCase('Never run');
      const passingCase = await createCase('Runs green');
      await link({
        sourceType: 'requirement',
        sourceId: written.id,
        targetType: 'test_case',
        targetId: untestedCase.id,
        linkType: 'verifies',
      });
      await link({
        sourceType: 'requirement',
        sourceId: executed.id,
        targetType: 'test_case',
        targetId: passingCase.id,
        linkType: 'verifies',
      });
      await executeCase(passingCase.id, 'passed');

      const result = await matrix();

      const rows = new Map(
        result.rows.map((row: { requirementId: string }) => [row.requirementId, row]),
      );
      expect(rows.get(written.id)).toMatchObject({ covered: true, verified: false });
      expect(rows.get(written.id).cases[0].lastStatus).toBe('untested');
      expect(rows.get(executed.id)).toMatchObject({ covered: true, verified: true });
      expect(result.summary).toMatchObject({ requirements: 2, covered: 2, verified: 1 });
    });

    it('stops counting a requirement as verified while an open defect points at it', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      await link({
        sourceType: 'requirement',
        sourceId: requirement.id,
        targetType: 'test_case',
        targetId: testCase.id,
        linkType: 'verifies',
      });
      await executeCase(testCase.id, 'passed');
      const defect = await createDefect({ requirementIds: [requirement.id] });

      const withDefect = await matrix();
      expect(withDefect.rows[0]).toMatchObject({ covered: true, verified: false });
      expect(withDefect.rows[0].defectIds).toEqual([defect.json().id]);
      expect(withDefect.summary.openDefects).toBe(1);

      await request(
        'POST',
        `/api/v1/defects/${defect.json().id}/status`,
        asOwner({ status: 'rejected' }),
      );

      const afterRejecting = await matrix();
      expect(afterRejecting.rows[0]).toMatchObject({ verified: true, defectIds: [] });
      expect(afterRejecting.summary.openDefects).toBe(0);
    });

    it('shows the failing status of a covered requirement', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      await link({
        sourceType: 'requirement',
        sourceId: requirement.id,
        targetType: 'test_case',
        targetId: testCase.id,
        linkType: 'verifies',
      });
      await executeCase(testCase.id, 'failed');

      const result = await matrix();

      expect(result.rows[0].cases[0].lastStatus).toBe('failed');
      expect(result.rows[0].verified).toBe(false);
    });

    it('can list only what is uncovered', async () => {
      const uncovered = await createRequirement('Nobody tested this');
      const covered = await createRequirement('This one is tested');
      const testCase = await createCase();
      await link({
        sourceType: 'requirement',
        sourceId: covered.id,
        targetType: 'test_case',
        targetId: testCase.id,
        linkType: 'verifies',
      });

      const result = await matrix('&uncoveredOnly=true');

      expect(result.rows.map((row: { requirementId: string }) => row.requirementId)).toEqual([
        uncovered.id,
      ]);
      // The summary still describes the whole project, not the filtered view.
      expect(result.summary).toMatchObject({ requirements: 2, covered: 1, coverage: 50 });
    });
  });

  describe('cross-organization isolation', () => {
    let stranger: TestWorkspace;
    let defectId: string;

    beforeEach(async () => {
      defectId = (await createDefect()).json().id;
      stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });
    });

    const asStranger = (payload?: object) => ({
      ...(payload === undefined ? {} : { payload }),
      token: stranger.owner.accessToken,
      organizationId: stranger.organizationId,
    });

    it('hides the defect and refuses to move or delete it', async () => {
      const read = await request('GET', `/api/v1/defects/${defectId}`, asStranger());
      const moved = await request(
        'POST',
        `/api/v1/defects/${defectId}/status`,
        asStranger({ status: 'rejected' }),
      );
      const deleted = await request('DELETE', `/api/v1/defects/${defectId}`, asStranger());

      expect([read.statusCode, moved.statusCode, deleted.statusCode]).toEqual([404, 404, 404]);
      const untouched = await prisma.defect.findUniqueOrThrow({ where: { id: defectId } });
      expect(untouched.status).toBe('open');
      expect(untouched.deletedAt).toBeNull();
    });

    it('does not leak defects through the list or the matrix', async () => {
      const listed = await request(
        'GET',
        `/api/v1/defects?projectId=${workspace.projectId}`,
        asStranger(),
      );
      const matrix = await request(
        'GET',
        `/api/v1/traceability/matrix?projectId=${workspace.projectId}`,
        asStranger(),
      );

      expect(listed.json().data).toEqual([]);
      expect(matrix.statusCode).toBe(404);
    });
  });
});
