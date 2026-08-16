import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MatrixRow } from '@qa-flow-hub/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Traceability links have no foreign keys — the endpoints are polymorphic — so
 * nothing in PostgreSQL stops a link from outliving the entity it points at.
 * These tests are that missing constraint: written where a report can be
 * corrupted, which is the only place a dangling link actually costs money.
 */
describe('traceability integrity', () => {
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

  const createCase = async (title = 'Pay with a valid card', suite = suiteId) =>
    (await request('POST', '/api/v1/test-cases', asOwner({ suiteId: suite, title }))).json();

  const link = (payload: object) => request('POST', '/api/v1/traceability/links', asOwner(payload));

  const verifies = async (requirementId: string, testCaseId: string) =>
    link({
      sourceType: 'requirement',
      sourceId: requirementId,
      targetType: 'test_case',
      targetId: testCaseId,
      linkType: 'verifies',
    });

  /** Runs a case, records one result and returns both ids. */
  const executeCase = async (
    testCaseId: string,
    status: string,
  ): Promise<{ runId: string; resultId: string }> => {
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
    return { runId, resultId: result.json().id };
  };

  const matrix = async (projectId = workspace.projectId) =>
    (
      await request('GET', `/api/v1/traceability/matrix?projectId=${projectId}`, asOwner())
    ).json();

  const rowFor = async (requirementId: string, projectId?: string): Promise<MatrixRow> => {
    const result = await matrix(projectId);
    const row = result.rows.find(
      (candidate: MatrixRow) => candidate.requirementId === requirementId,
    );
    if (row === undefined) {
      throw new Error(`No matrix row for ${requirementId}`);
    }
    return row;
  };

  const lastDeletionOf = (entityType: string) =>
    prisma.auditLog.findFirst({
      where: { entityType, action: 'delete' },
      orderBy: { createdAt: 'desc' },
    });

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

  describe('creating a link', () => {
    it('refuses a deleted requirement, case, run or defect as an end', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      const { runId, resultId } = await executeCase(testCase.id, 'failed');
      const defect = (
        await request(
          'POST',
          '/api/v1/defects',
          asOwner({
            projectId: workspace.projectId,
            title: 'Payment button does nothing',
            testResultId: resultId,
          }),
        )
      ).json();
      const survivor = await createRequirement('Still alive');

      await request('DELETE', `/api/v1/requirements/${requirement.id}`, asOwner());
      await request('DELETE', `/api/v1/test-cases/${testCase.id}`, asOwner());
      await request('DELETE', `/api/v1/defects/${defect.id}`, asOwner());
      // The run goes last: deleting it takes the result with it.
      await request('DELETE', `/api/v1/test-runs/${runId}`, asOwner());

      const attempts = await Promise.all([
        verifies(requirement.id, (await createCase('Fresh case')).id),
        verifies(survivor.id, testCase.id),
        link({
          sourceType: 'requirement',
          sourceId: survivor.id,
          targetType: 'defect',
          targetId: defect.id,
        }),
        link({
          sourceType: 'requirement',
          sourceId: survivor.id,
          targetType: 'test_run',
          targetId: runId,
        }),
        link({
          sourceType: 'requirement',
          sourceId: survivor.id,
          targetType: 'test_result',
          targetId: resultId,
        }),
      ]);

      expect(attempts.map((attempt) => attempt.statusCode)).toEqual([400, 400, 400, 400, 400]);
    });
  });

  describe('deleting an end', () => {
    it('purges the links of a deleted requirement in both directions', async () => {
      const requirement = await createRequirement();
      const other = await createRequirement('Blocked by payment');
      const testCase = await createCase();
      await verifies(requirement.id, testCase.id);
      await link({
        sourceType: 'requirement',
        sourceId: other.id,
        targetType: 'requirement',
        targetId: requirement.id,
        linkType: 'blocks',
      });
      expect(await prisma.traceabilityLink.count()).toBe(2);

      await request('DELETE', `/api/v1/requirements/${requirement.id}`, asOwner());

      expect(await prisma.traceabilityLink.count()).toBe(0);
      expect((await lastDeletionOf('Requirement'))?.changes).toMatchObject({
        removedTraceabilityLinks: 2,
      });
    });

    it('purges the links of a deleted case', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      await verifies(requirement.id, testCase.id);

      await request('DELETE', `/api/v1/test-cases/${testCase.id}`, asOwner());

      expect(await prisma.traceabilityLink.count()).toBe(0);
      expect((await lastDeletionOf('TestCase'))?.changes).toMatchObject({
        removedTraceabilityLinks: 1,
      });
      expect((await rowFor(requirement.id)).covered).toBe(false);
    });

    it('purges the links of the cases a deleted suite takes with it', async () => {
      const requirement = await createRequirement();
      const first = await createCase('First case');
      const second = await createCase('Second case');
      await verifies(requirement.id, first.id);
      await verifies(requirement.id, second.id);

      await request('DELETE', `/api/v1/test-suites/${suiteId}`, asOwner());

      expect(await prisma.traceabilityLink.count()).toBe(0);
      expect((await lastDeletionOf('TestSuite'))?.changes).toMatchObject({
        removedCases: 2,
        removedTraceabilityLinks: 2,
      });
    });

    it('purges the links of a deleted run and of the results it contained', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      const { runId, resultId } = await executeCase(testCase.id, 'failed');
      await link({
        sourceType: 'requirement',
        sourceId: requirement.id,
        targetType: 'test_run',
        targetId: runId,
      });
      await link({
        sourceType: 'requirement',
        sourceId: requirement.id,
        targetType: 'test_result',
        targetId: resultId,
      });

      await request('DELETE', `/api/v1/test-runs/${runId}`, asOwner());

      expect(await prisma.traceabilityLink.count()).toBe(0);
      // The result itself is untouched: evidence that a test failed is history.
      expect(await prisma.testResult.count()).toBe(1);
      expect((await lastDeletionOf('TestRun'))?.changes).toMatchObject({
        removedTraceabilityLinks: 2,
      });
    });

    it('purges the links of a deleted defect, including the one to its origin', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      const { resultId } = await executeCase(testCase.id, 'failed');
      const defect = (
        await request(
          'POST',
          '/api/v1/defects',
          asOwner({
            projectId: workspace.projectId,
            title: 'Payment button does nothing',
            testResultId: resultId,
            requirementIds: [requirement.id],
          }),
        )
      ).json();
      expect(await prisma.traceabilityLink.count()).toBe(2);

      await request('DELETE', `/api/v1/defects/${defect.id}`, asOwner());

      expect(await prisma.traceabilityLink.count()).toBe(0);
      expect((await lastDeletionOf('Defect'))?.changes).toMatchObject({
        removedTraceabilityLinks: 2,
      });
    });

    it('leaves the links of another project alone', async () => {
      const otherProject = (
        await request('POST', '/api/v1/projects', asOwner({ name: 'Mobile', key: 'MOB' }))
      ).json();
      const otherSuite = (
        await request(
          'POST',
          '/api/v1/test-suites',
          asOwner({ projectId: otherProject.id, name: 'Onboarding' }),
        )
      ).json();
      const otherRequirement = (
        await request(
          'POST',
          '/api/v1/requirements',
          asOwner({ projectId: otherProject.id, title: 'The user can sign up' }),
        )
      ).json();
      const otherCase = await createCase('Sign up with an email', otherSuite.id);
      await verifies(otherRequirement.id, otherCase.id);

      const requirement = await createRequirement();
      const testCase = await createCase();
      await verifies(requirement.id, testCase.id);

      await request('DELETE', `/api/v1/requirements/${requirement.id}`, asOwner());

      const surviving = await prisma.traceabilityLink.findMany();
      expect(surviving).toHaveLength(1);
      expect(surviving[0]).toMatchObject({ sourceId: otherRequirement.id, targetId: otherCase.id });
      expect((await rowFor(otherRequirement.id, otherProject.id)).covered).toBe(true);
    });

    it('keeps the isolation of another organization when it deletes its own entities', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      await verifies(requirement.id, testCase.id);

      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });
      const refused = await request('DELETE', `/api/v1/requirements/${requirement.id}`, {
        token: stranger.owner.accessToken,
        organizationId: stranger.organizationId,
      });

      expect(refused.statusCode).toBe(404);
      expect(await prisma.traceabilityLink.count()).toBe(1);
    });
  });

  describe('archiving a case', () => {
    it('keeps the link but stops counting as coverage, and counts again once restored', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      await verifies(requirement.id, testCase.id);
      await executeCase(testCase.id, 'passed');

      expect(await rowFor(requirement.id)).toMatchObject({ covered: true, verified: true });

      await request('POST', `/api/v1/test-cases/${testCase.id}/archive`, asOwner());

      const archived = await rowFor(requirement.id);
      expect(archived).toMatchObject({ covered: false, verified: false });
      // The row still shows the case, flagged, so the report explains itself
      // instead of silently losing a line.
      expect(archived.cases).toHaveLength(1);
      expect(archived.cases[0]).toMatchObject({ id: testCase.id, archived: true });
      expect(await prisma.traceabilityLink.count()).toBe(1);

      await request('POST', `/api/v1/test-cases/${testCase.id}/restore`, asOwner());

      const restored = await rowFor(requirement.id);
      expect(restored).toMatchObject({ covered: true, verified: true });
      expect(restored.cases[0]?.archived).toBe(false);
      // No new link was needed: restoring brought the coverage back on its own.
      expect(await prisma.traceabilityLink.count()).toBe(1);
    });

    it('still accepts a new link to an archived case', async () => {
      const requirement = await createRequirement();
      const testCase = await createCase();
      await request('POST', `/api/v1/test-cases/${testCase.id}/archive`, asOwner());

      const created = await verifies(requirement.id, testCase.id);

      expect(created.statusCode).toBe(201);
      expect((await rowFor(requirement.id)).covered).toBe(false);
    });
  });
});
