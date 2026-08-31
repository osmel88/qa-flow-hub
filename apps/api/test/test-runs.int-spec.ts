import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Execution is where the product stops being a catalogue. The invariants worth
 * paying for are here: a run reports what was executed, not what the case says
 * today, and a result is never overwritten.
 */
describe('test runs', () => {
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

  const createCase = async (payload: object = {}): Promise<{ id: string; key: string }> => {
    const response = await request(
      'POST',
      '/api/v1/test-cases',
      asOwner({ suiteId, title: 'Pay with a valid card', ...payload }),
    );
    return response.json();
  };

  const createRun = (payload: object = {}) =>
    request(
      'POST',
      '/api/v1/test-runs',
      asOwner({ projectId: workspace.projectId, name: 'Release 1.0 regression', ...payload }),
    );

  const casesOf = async (runId: string) =>
    (await request('GET', `/api/v1/test-runs/${runId}/cases`, asOwner())).json().data;

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

  describe('planning', () => {
    it('creates an empty planned run', async () => {
      const response = await createRun();

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        status: 'planned',
        startedAt: null,
        progress: { total: 0, executed: 0, completion: 0 },
      });
    });

    it('includes cases selected by id', async () => {
      const first = await createCase({ title: 'Pay with a valid card' });
      const second = await createCase({ title: 'Pay with an expired card' });

      const run = await createRun({ selection: { testCaseIds: [first.id, second.id] } });

      expect(run.json().progress).toMatchObject({ total: 2, untested: 2, executed: 0 });
      const cases = await casesOf(run.json().id);
      expect(cases.map((runCase: { position: number }) => runCase.position)).toEqual([1, 2]);
    });

    it('includes cases selected by tag', async () => {
      await createCase({ title: 'Smoke one', tags: ['smoke'] });
      await createCase({ title: 'Not in the smoke pack', tags: ['regression'] });

      const run = await createRun({ selection: { tag: 'smoke' } });

      expect(run.json().progress.total).toBe(1);
    });

    it('rejects mixing ids and filters', async () => {
      const only = await createCase();

      const response = await createRun({
        selection: { testCaseIds: [only.id], tag: 'smoke' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a selection that matches nothing', async () => {
      const response = await createRun({ selection: { tag: 'nonexistent' } });

      expect(response.statusCode).toBe(400);
      expect(await prisma.testRun.count()).toBe(0);
    });

    it('refuses an id that belongs to another project', async () => {
      const otherProject = await request(
        'POST',
        '/api/v1/projects',
        asOwner({ name: 'Mobile', key: 'MOB' }),
      );
      const otherSuite = await request(
        'POST',
        '/api/v1/test-suites',
        asOwner({ projectId: otherProject.json().id, name: 'Checkout' }),
      );
      const foreign = await request(
        'POST',
        '/api/v1/test-cases',
        asOwner({ suiteId: otherSuite.json().id, title: 'Mobile case' }),
      );

      const response = await createRun({ selection: { testCaseIds: [foreign.json().id] } });

      expect(response.statusCode).toBe(400);
    });

    it('never includes an archived case', async () => {
      const archived = await createCase({ title: 'Retired case' });
      await request('POST', `/api/v1/test-cases/${archived.id}/archive`, asOwner({}));
      await createCase({ title: 'Still current' });

      const run = await createRun({ selection: { suiteId } });

      expect(run.json().progress.total).toBe(1);
    });

    it('adds cases later without duplicating the ones already in', async () => {
      const first = await createCase({ title: 'Pay with a valid card' });
      const run = await createRun({ selection: { testCaseIds: [first.id] } });
      const second = await createCase({ title: 'Pay with an expired card' });

      const response = await request(
        'POST',
        `/api/v1/test-runs/${run.json().id}/cases`,
        asOwner({ selection: { suiteId } }),
      );

      expect(response.json()).toEqual({ added: 1 });
      const cases = await casesOf(run.json().id);
      expect(cases).toHaveLength(2);
      expect(cases.map((runCase: { position: number }) => runCase.position)).toEqual([1, 2]);
      expect(cases[1].testCaseId).toBe(second.id);
    });
  });

  describe('snapshots', () => {
    it('freezes the case as it was when it entered the run', async () => {
      const original = await createCase({
        title: 'Pay with a valid card',
        steps: [{ action: 'Enter the card number', expectedResult: 'The form accepts it' }],
      });
      const run = await createRun({ selection: { testCaseIds: [original.id] } });

      await request(
        'POST',
        `/api/v1/test-cases/${original.id}/steps`,
        asOwner({ steps: [{ action: 'Completely different instructions' }] }),
      );
      await request(
        'PATCH',
        `/api/v1/test-cases/${original.id}`,
        asOwner({ title: 'Renamed after the run started' }),
      );

      const [runCase] = await casesOf(run.json().id);
      expect(runCase.snapshot.title).toBe('Pay with a valid card');
      expect(runCase.snapshot.steps).toEqual([
        { position: 1, action: 'Enter the card number', expectedResult: 'The form accepts it' },
      ]);
      expect(runCase.caseVersion).toBe(1);
    });
  });

  describe('assignment', () => {
    it('assigns and unassigns in bulk', async () => {
      const testCase = await createCase();
      const run = await createRun({ selection: { testCaseIds: [testCase.id] } });
      const tester = await workspace.addMember('tester');
      const [runCase] = await casesOf(run.json().id);

      const assigned = await request(
        'POST',
        `/api/v1/test-runs/${run.json().id}/assignments`,
        asOwner({ runCaseIds: [runCase.id], assignedToId: tester.userId }),
      );
      expect(assigned.json()).toEqual({ assigned: 1 });

      const unassigned = await request(
        'POST',
        `/api/v1/test-runs/${run.json().id}/assignments`,
        asOwner({ runCaseIds: [runCase.id], assignedToId: null }),
      );
      expect(unassigned.json()).toEqual({ assigned: 1 });
      expect((await casesOf(run.json().id))[0].assignedToId).toBeNull();
    });

    it('refuses to assign somebody outside the organization', async () => {
      const testCase = await createCase();
      const run = await createRun({ selection: { testCaseIds: [testCase.id] } });
      const [runCase] = await casesOf(run.json().id);
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });

      const response = await request(
        'POST',
        `/api/v1/test-runs/${run.json().id}/assignments`,
        asOwner({ runCaseIds: [runCase.id], assignedToId: stranger.owner.userId }),
      );

      expect(response.statusCode).toBe(400);
    });
  });

  describe('recording results', () => {
    let runId: string;
    let runCaseId: string;

    beforeEach(async () => {
      const testCase = await createCase({
        steps: [{ action: 'Enter the card number' }, { action: 'Confirm the payment' }],
      });
      const run = await createRun({ selection: { testCaseIds: [testCase.id] } });
      runId = run.json().id;
      runCaseId = (await casesOf(runId))[0].id;
    });

    const record = (payload: object) =>
      request('POST', `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`, asOwner(payload));

    it('records a result and starts the run', async () => {
      const response = await record({ status: 'passed', comment: 'Went through' });

      expect(response.statusCode).toBe(201);
      const run = (await request('GET', `/api/v1/test-runs/${runId}`, asOwner())).json();
      expect(run.status).toBe('in_progress');
      expect(run.startedAt).not.toBeNull();
      expect(run.progress).toMatchObject({
        total: 1,
        passed: 1,
        untested: 0,
        executed: 1,
        completion: 100,
      });
    });

    it('appends instead of overwriting when a case is retested', async () => {
      await record({ status: 'failed', comment: 'Card declined' });
      await record({ status: 'passed', comment: 'Fixed and retested' });

      const history = (
        await request(
          'GET',
          `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
          asOwner(),
        )
      ).json();

      expect(history.map((result: { status: string }) => result.status)).toEqual([
        'passed',
        'failed',
      ]);
      // The projection follows the newest attempt; the failure stays on record.
      expect((await casesOf(runId))[0].latestStatus).toBe('passed');
    });

    it('refuses untested as a recordable outcome', async () => {
      const response = await record({ status: 'untested' });

      expect(response.statusCode).toBe(400);
    });

    it('accepts per-step outcomes that exist in the snapshot', async () => {
      const response = await record({
        status: 'failed',
        stepResults: [
          { position: 1, status: 'passed' },
          { position: 2, status: 'failed', comment: 'Timed out' },
        ],
      });

      expect(response.json().stepResults).toHaveLength(2);
    });

    it('rejects a step that the executed version never had', async () => {
      const response = await record({
        status: 'failed',
        stepResults: [{ position: 9, status: 'failed' }],
      });

      expect(response.statusCode).toBe(400);
      expect(await prisma.testResult.count()).toBe(0);
    });

    it('lets a tester execute their own case and not somebody else’s', async () => {
      const tester = await workspace.addMember('tester');
      const other = await workspace.addMember('tester', 'other.tester');
      await request(
        'POST',
        `/api/v1/test-runs/${runId}/assignments`,
        asOwner({ runCaseIds: [runCaseId], assignedToId: other.userId }),
      );

      const asTester = {
        payload: { status: 'passed' },
        token: tester.accessToken,
        organizationId: workspace.organizationId,
      };
      const refused = await request(
        'POST',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
        asTester,
      );
      expect(refused.statusCode).toBe(403);

      await request(
        'POST',
        `/api/v1/test-runs/${runId}/assignments`,
        asOwner({ runCaseIds: [runCaseId], assignedToId: tester.userId }),
      );
      const allowed = await request(
        'POST',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
        asTester,
      );
      expect(allowed.statusCode).toBe(201);
    });

    it('does not let a viewer record anything', async () => {
      const viewer = await workspace.addMember('viewer');

      const response = await request(
        'POST',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
        {
          payload: { status: 'passed' },
          token: viewer.accessToken,
          organizationId: workspace.organizationId,
        },
      );

      expect(response.statusCode).toBe(403);
    });
  });

  describe('lifecycle', () => {
    it('closes a run and freezes it', async () => {
      const testCase = await createCase();
      const run = await createRun({ selection: { testCaseIds: [testCase.id] } });
      const runId = run.json().id;
      const runCaseId = (await casesOf(runId))[0].id;

      const completed = await request('POST', `/api/v1/test-runs/${runId}/complete`, asOwner({}));
      expect(completed.statusCode).toBe(409);

      await request('POST', `/api/v1/test-runs/${runId}/start`, asOwner({}));
      const closed = await request('POST', `/api/v1/test-runs/${runId}/complete`, asOwner({}));
      expect(closed.json()).toMatchObject({ status: 'completed' });
      expect(closed.json().completedAt).not.toBeNull();

      const late = await request(
        'POST',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
        asOwner({ status: 'passed' }),
      );
      const renamed = await request(
        'PATCH',
        `/api/v1/test-runs/${runId}`,
        asOwner({ name: 'Renamed after closing' }),
      );

      expect([late.statusCode, renamed.statusCode]).toEqual([409, 409]);
    });

    it('cannot reopen a completed run', async () => {
      const run = await createRun();
      const runId = run.json().id;
      await request('POST', `/api/v1/test-runs/${runId}/start`, asOwner({}));
      await request('POST', `/api/v1/test-runs/${runId}/complete`, asOwner({}));

      const response = await request('POST', `/api/v1/test-runs/${runId}/start`, asOwner({}));

      expect(response.statusCode).toBe(409);
    });

    it('keeps an executed case in the run', async () => {
      const testCase = await createCase();
      const run = await createRun({ selection: { testCaseIds: [testCase.id] } });
      const runId = run.json().id;
      const runCaseId = (await casesOf(runId))[0].id;
      await request(
        'POST',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
        asOwner({ status: 'failed' }),
      );

      const response = await request(
        'DELETE',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}`,
        asOwner(),
      );

      expect(response.statusCode).toBe(409);
      expect(await prisma.testResult.count()).toBe(1);
    });

    it('removes a case that was never executed', async () => {
      const testCase = await createCase();
      const run = await createRun({ selection: { testCaseIds: [testCase.id] } });
      const runId = run.json().id;
      const runCaseId = (await casesOf(runId))[0].id;

      const response = await request(
        'DELETE',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}`,
        asOwner(),
      );

      expect(response.statusCode).toBe(204);
      expect(await casesOf(runId)).toEqual([]);
    });
  });

  describe('cross-organization isolation', () => {
    let stranger: TestWorkspace;
    let runId: string;
    let runCaseId: string;

    beforeEach(async () => {
      const testCase = await createCase();
      runId = (await createRun({ selection: { testCaseIds: [testCase.id] } })).json().id;
      runCaseId = (await casesOf(runId))[0].id;
      stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });
    });

    const asStranger = (payload?: object) => ({
      ...(payload === undefined ? {} : { payload }),
      token: stranger.owner.accessToken,
      organizationId: stranger.organizationId,
    });

    it('hides the run, its cases and its results', async () => {
      const run = await request('GET', `/api/v1/test-runs/${runId}`, asStranger());
      const cases = await request('GET', `/api/v1/test-runs/${runId}/cases`, asStranger());
      const results = await request(
        'GET',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
        asStranger(),
      );

      expect([run.statusCode, cases.statusCode, results.statusCode]).toEqual([404, 404, 404]);
    });

    it('refuses to record a result into another organization’s run', async () => {
      const response = await request(
        'POST',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
        asStranger({ status: 'passed' }),
      );

      expect(response.statusCode).toBe(404);
      expect(await prisma.testResult.count()).toBe(0);
    });

    it('refuses to close or delete another organization’s run', async () => {
      const completed = await request(
        'POST',
        `/api/v1/test-runs/${runId}/complete`,
        asStranger({}),
      );
      const deleted = await request('DELETE', `/api/v1/test-runs/${runId}`, asStranger());

      expect([completed.statusCode, deleted.statusCode]).toEqual([404, 404]);
      const untouched = await prisma.testRun.findUniqueOrThrow({ where: { id: runId } });
      expect(untouched.status).toBe('planned');
      expect(untouched.deletedAt).toBeNull();
    });

    it('does not list another organization’s runs', async () => {
      const response = await request(
        'GET',
        `/api/v1/test-runs?projectId=${workspace.projectId}`,
        asStranger(),
      );

      expect(response.json().data).toEqual([]);
    });
  });
});
