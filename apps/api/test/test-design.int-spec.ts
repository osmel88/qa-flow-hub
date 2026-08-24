import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * The happy path, plus the invariants that are expensive to discover late:
 * tenant isolation, tree bounds, step consistency and counter behaviour.
 */
describe('test design', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let workspace: TestWorkspace;

  const request = injector(() => app);

  const asOwner = (payload?: object) => ({
    ...(payload === undefined ? {} : { payload }),
    token: workspace.owner.accessToken,
    organizationId: workspace.organizationId,
  });

  const createSuite = (name = 'Checkout') =>
    request('POST', '/api/v1/test-suites', asOwner({ projectId: workspace.projectId, name }));

  const createCase = (suiteId: string, payload: object = {}) =>
    request(
      'POST',
      '/api/v1/test-cases',
      asOwner({ suiteId, title: 'Pay with a valid card', ...payload }),
    );

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    workspace = await createWorkspace(app);
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  it('creates a suite, a case and its ordered steps', async () => {
    const suite = await createSuite();

    const testCase = await createCase(suite.json().id, {
      steps: [
        { action: 'Open the cart', expectedResult: 'The cart shows one item' },
        { action: 'Pay', expectedResult: 'The order is confirmed' },
      ],
    });

    expect(testCase.json().key).toBe('WEB-C-1');
    expect(testCase.json().steps.map((step: { position: number }) => step.position)).toEqual([
      1, 2,
    ]);
  });

  it('rejects a second suite with the same name in one project', async () => {
    await createSuite();

    expect((await createSuite()).statusCode).toBe(409);
  });

  it('renumbers steps when the list is replaced', async () => {
    const suite = await createSuite();
    const id = (
      await createCase(suite.json().id, { steps: [{ action: 'Only step' }] })
    ).json().id;

    const response = await request(
      'POST',
      `/api/v1/test-cases/${id}/steps`,
      asOwner({ steps: [{ action: 'First' }, { action: 'Second' }, { action: 'Third' }] }),
    );

    expect(response.json().steps.map((step: { action: string }) => step.action)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
    expect(response.json().version).toBe(2);
  });

  /**
   * Regression: the editor used to send a field update and a step replacement
   * as two requests, so one save moved the version by two. Saving both in one
   * request has to move it by exactly one, and the returned steps have to be
   * the new ones — a single bump with the old steps would be worse.
   */
  it('counts one save as one version even when it carries fields and steps', async () => {
    const suite = await createSuite();
    const id = (await createCase(suite.json().id, { steps: [{ action: 'Only step' }] })).json().id;

    const first = await request(
      'PATCH',
      `/api/v1/test-cases/${id}`,
      asOwner({ title: 'Pay with an expired card', steps: [{ action: 'First' }] }),
    );
    expect(first.json().version).toBe(2);
    expect(first.json().steps.map((step: { action: string }) => step.action)).toEqual(['First']);

    const second = await request(
      'PATCH',
      `/api/v1/test-cases/${id}`,
      asOwner({ title: 'Pay with a blocked card', steps: [{ action: 'First' }, { action: 'Second' }] }),
    );
    expect(second.json().version).toBe(3);
    expect(second.json().steps).toHaveLength(2);

    // One audit row per save, not two: the log is what a report cites.
    const audits = await prisma.auditLog.findMany({ where: { entityId: id, action: 'update' } });
    expect(audits).toHaveLength(2);
  });

  it('leaves the steps alone when a save carries only fields', async () => {
    const suite = await createSuite();
    const id = (await createCase(suite.json().id, { steps: [{ action: 'Only step' }] })).json().id;

    const response = await request(
      'PATCH',
      `/api/v1/test-cases/${id}`,
      asOwner({ priority: 'high' }),
    );

    expect(response.json().version).toBe(2);
    expect(response.json().steps.map((step: { action: string }) => step.action)).toEqual([
      'Only step',
    ]);
  });

  it('duplicates a case with its steps under a new key', async () => {
    const suite = await createSuite();
    const source = await createCase(suite.json().id, {
      steps: [{ action: 'Open the cart' }, { action: 'Pay' }],
    });

    const copy = await request(
      'POST',
      `/api/v1/test-cases/${source.json().id}/duplicate`,
      asOwner({}),
    );

    expect(copy.json().key).toBe('WEB-C-2');
    expect(copy.json().title).toBe('Pay with a valid card (copy)');
    expect(copy.json().steps).toHaveLength(2);
    expect(copy.json().version).toBe(1);
  });

  it('makes an archived case read-only until it is restored', async () => {
    const suite = await createSuite();
    const id = (await createCase(suite.json().id)).json().id;

    await request('POST', `/api/v1/test-cases/${id}/archive`, asOwner({}));
    const edit = await request(
      'PATCH',
      `/api/v1/test-cases/${id}`,
      asOwner({ title: 'Changed while archived' }),
    );
    expect(edit.statusCode).toBe(409);

    await request('POST', `/api/v1/test-cases/${id}/restore`, asOwner({}));
    const afterRestore = await request(
      'PATCH',
      `/api/v1/test-cases/${id}`,
      asOwner({ title: 'Changed after restore' }),
    );
    expect(afterRestore.statusCode).toBe(200);
  });

  it('hides archived cases from the default listing', async () => {
    const suite = await createSuite();
    const id = (await createCase(suite.json().id)).json().id;
    await request('POST', `/api/v1/test-cases/${id}/archive`, asOwner({}));

    const listed = await request(
      'GET',
      `/api/v1/test-cases?projectId=${workspace.projectId}`,
      asOwner(),
    );
    const withArchived = await request(
      'GET',
      `/api/v1/test-cases?projectId=${workspace.projectId}&includeArchived=true`,
      asOwner(),
    );

    expect(listed.json().data).toHaveLength(0);
    expect(withArchived.json().data).toHaveLength(1);
  });

  it('builds the section tree and refuses a cycle', async () => {
    const suiteId = (await createSuite()).json().id;
    const parent = await request('POST', '/api/v1/test-sections', asOwner({ suiteId, name: 'Cart' }));
    const child = await request(
      'POST',
      '/api/v1/test-sections',
      asOwner({ suiteId, name: 'Discounts', parentId: parent.json().id }),
    );

    const tree = await request('GET', `/api/v1/test-suites/${suiteId}/sections`, asOwner());
    expect(tree.json()).toHaveLength(1);
    expect(tree.json()[0].children[0].name).toBe('Discounts');

    const cycle = await request(
      'PATCH',
      `/api/v1/test-sections/${parent.json().id}`,
      asOwner({ parentId: child.json().id }),
    );
    expect(cycle.statusCode).toBe(400);
  });

  it('keeps cases when their section is deleted', async () => {
    const suiteId = (await createSuite()).json().id;
    const section = await request(
      'POST',
      '/api/v1/test-sections',
      asOwner({ suiteId, name: 'Cart' }),
    );
    const id = (await createCase(suiteId, { sectionId: section.json().id })).json().id;

    await request('DELETE', `/api/v1/test-sections/${section.json().id}`, asOwner());

    const testCase = await request('GET', `/api/v1/test-cases/${id}`, asOwner());
    expect(testCase.statusCode).toBe(200);
    expect(testCase.json().sectionId).toBeNull();
  });

  it('refuses a case whose section belongs to another suite', async () => {
    const first = await createSuite('Checkout');
    const second = await createSuite('Search');
    const section = await request(
      'POST',
      '/api/v1/test-sections',
      asOwner({ suiteId: second.json().id, name: 'Filters' }),
    );

    const response = await createCase(first.json().id, { sectionId: section.json().id });

    expect(response.statusCode).toBe(400);
  });

  it('does not let a tester author cases', async () => {
    const suiteId = (await createSuite()).json().id;
    const tester = await workspace.addMember('tester');

    const response = await request('POST', '/api/v1/test-cases', {
      payload: { suiteId, title: 'Written by a tester' },
      token: tester.accessToken,
      organizationId: workspace.organizationId,
    });

    expect(response.statusCode).toBe(403);
  });

  describe('cross-organization isolation', () => {
    /**
     * The realistic attack: a legitimate user of another organization who knows
     * the exact ids. Every one of these must fail, and fail with 404 rather
     * than 403, because 403 would confirm the resource exists.
     */
    let stranger: TestWorkspace;
    let suiteId: string;
    let sectionId: string;
    let caseId: string;

    const asStranger = (payload?: object) => ({
      ...(payload === undefined ? {} : { payload }),
      token: stranger.owner.accessToken,
      organizationId: stranger.organizationId,
    });

    beforeEach(async () => {
      suiteId = (await createSuite()).json().id;
      sectionId = (
        await request('POST', '/api/v1/test-sections', asOwner({ suiteId, name: 'Cart' }))
      ).json().id;
      caseId = (
        await createCase(suiteId, { sectionId, steps: [{ action: 'Open the cart' }] })
      ).json().id;
      stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });
    });

    it('does not list another organization’s suites', async () => {
      const response = await request(
        'GET',
        `/api/v1/test-suites?projectId=${workspace.projectId}`,
        asStranger(),
      );

      expect(response.json()).toEqual([]);
    });

    it('does not list another organization’s cases', async () => {
      const response = await request(
        'GET',
        `/api/v1/test-cases?projectId=${workspace.projectId}`,
        asStranger(),
      );

      expect(response.json().data).toEqual([]);
    });

    it('hides a case behind a 404, steps included', async () => {
      const response = await request('GET', `/api/v1/test-cases/${caseId}`, asStranger());

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('Open the cart');
    });

    it('refuses to edit, archive or delete a case it cannot see', async () => {
      const edited = await request(
        'PATCH',
        `/api/v1/test-cases/${caseId}`,
        asStranger({ title: 'Owned' }),
      );
      const archived = await request(
        'POST',
        `/api/v1/test-cases/${caseId}/archive`,
        asStranger({}),
      );
      const deleted = await request('DELETE', `/api/v1/test-cases/${caseId}`, asStranger());

      expect([edited.statusCode, archived.statusCode, deleted.statusCode]).toEqual([
        404, 404, 404,
      ]);
      const untouched = await prisma.testCase.findUniqueOrThrow({ where: { id: caseId } });
      expect(untouched.title).toBe('Pay with a valid card');
      expect(untouched.archivedAt).toBeNull();
      expect(untouched.deletedAt).toBeNull();
    });

    it('refuses to rewrite the steps of a case it cannot see', async () => {
      const response = await request(
        'POST',
        `/api/v1/test-cases/${caseId}/steps`,
        asStranger({ steps: [{ action: 'Injected' }] }),
      );

      expect(response.statusCode).toBe(404);
      expect(await prisma.testStep.count({ where: { testCaseId: caseId } })).toBe(1);
    });

    it('refuses to duplicate another organization’s case', async () => {
      const response = await request(
        'POST',
        `/api/v1/test-cases/${caseId}/duplicate`,
        asStranger({}),
      );

      expect(response.statusCode).toBe(404);
      expect(await prisma.testCase.count()).toBe(1);
    });

    it('refuses to read or delete another organization’s section tree', async () => {
      const tree = await request(
        'GET',
        `/api/v1/test-suites/${suiteId}/sections`,
        asStranger(),
      );
      const deleted = await request(
        'DELETE',
        `/api/v1/test-sections/${sectionId}`,
        asStranger(),
      );

      expect(tree.statusCode).toBe(404);
      expect(deleted.statusCode).toBe(404);
      const section = await prisma.testSection.findUniqueOrThrow({ where: { id: sectionId } });
      expect(section.deletedAt).toBeNull();
    });

    it('does not let a case be filed under another organization’s section', async () => {
      const ownSuite = (
        await request(
          'POST',
          '/api/v1/test-suites',
          asStranger({ projectId: stranger.projectId, name: 'Checkout' }),
        )
      ).json().id;

      const response = await request(
        'POST',
        '/api/v1/test-cases',
        asStranger({ suiteId: ownSuite, title: 'Cross tenant filing', sectionId }),
      );

      expect(response.statusCode).toBe(400);
    });
  });

  describe('section tree bounds', () => {
    it('allows five levels and rejects the sixth', async () => {
      const suiteId = (await createSuite()).json().id;

      let parentId: string | null = null;
      for (let level = 1; level <= 5; level += 1) {
        const response = await request(
          'POST',
          '/api/v1/test-sections',
          asOwner({
            suiteId,
            name: `Level ${level}`,
            ...(parentId === null ? {} : { parentId }),
          }),
        );
        expect(response.statusCode).toBe(201);
        parentId = response.json().id;
      }

      const sixth = await request(
        'POST',
        '/api/v1/test-sections',
        asOwner({ suiteId, name: 'Level 6', parentId }),
      );

      expect(sixth.statusCode).toBe(409);
      expect(sixth.json().error.message).toContain('5 levels');
    });

    it('refuses to reparent a section into a different suite', async () => {
      const first = (await createSuite('Checkout')).json().id;
      const second = (await createSuite('Search')).json().id;
      const section = await request(
        'POST',
        '/api/v1/test-sections',
        asOwner({ suiteId: first, name: 'Cart' }),
      );
      const foreignParent = await request(
        'POST',
        '/api/v1/test-sections',
        asOwner({ suiteId: second, name: 'Filters' }),
      );

      const response = await request(
        'PATCH',
        `/api/v1/test-sections/${section.json().id}`,
        asOwner({ parentId: foreignParent.json().id }),
      );

      expect(response.statusCode).toBe(400);
    });

    it('deletes a suite together with its sections and cases', async () => {
      const suiteId = (await createSuite()).json().id;
      const section = await request(
        'POST',
        '/api/v1/test-sections',
        asOwner({ suiteId, name: 'Cart' }),
      );
      await createCase(suiteId, { sectionId: section.json().id });

      await request('DELETE', `/api/v1/test-suites/${suiteId}`, asOwner());

      const listed = await request(
        'GET',
        `/api/v1/test-cases?projectId=${workspace.projectId}`,
        asOwner(),
      );
      expect(listed.json().data).toEqual([]);
      expect((await request('GET', '/api/v1/test-suites?projectId=' + workspace.projectId, asOwner())).json()).toEqual([]);
      // Soft delete: the rows survive so audit entries keep pointing at them.
      expect(await prisma.testCase.count()).toBe(1);
    });
  });

  describe('steps', () => {
    it('rejects an empty action', async () => {
      const suiteId = (await createSuite()).json().id;

      const response = await createCase(suiteId, { steps: [{ action: '   ' }] });

      expect(response.statusCode).toBe(400);
    });

    it('rejects more than a hundred steps', async () => {
      const suiteId = (await createSuite()).json().id;
      const steps = Array.from({ length: 101 }, (_, index) => ({ action: `Step ${index}` }));

      const response = await createCase(suiteId, { steps });

      expect(response.statusCode).toBe(400);
      expect(await prisma.testCase.count()).toBe(0);
    });

    it('accepts exactly a hundred', async () => {
      const suiteId = (await createSuite()).json().id;
      const steps = Array.from({ length: 100 }, (_, index) => ({ action: `Step ${index}` }));

      const response = await createCase(suiteId, { steps });

      expect(response.json().steps).toHaveLength(100);
      expect(response.json().steps[99].position).toBe(100);
    });

    it('empties the list when given no steps', async () => {
      const suiteId = (await createSuite()).json().id;
      const id = (await createCase(suiteId, { steps: [{ action: 'Only step' }] })).json().id;

      const response = await request(
        'POST',
        `/api/v1/test-cases/${id}/steps`,
        asOwner({ steps: [] }),
      );

      expect(response.json().steps).toEqual([]);
      expect(await prisma.testStep.count({ where: { testCaseId: id } })).toBe(0);
    });
  });

  describe('key reservation', () => {
    it('does not consume the counter when creation fails', async () => {
      const suiteId = (await createSuite()).json().id;
      await createCase(suiteId);

      // 101 steps fail validation before anything is written.
      const rejected = await createCase(suiteId, {
        steps: Array.from({ length: 101 }, () => ({ action: 'Too many' })),
      });
      expect(rejected.statusCode).toBe(400);

      // A section from another suite fails inside the service, after the
      // request has been accepted but before the transaction starts.
      const otherSuite = (await createSuite('Search')).json().id;
      const foreignSection = await request(
        'POST',
        '/api/v1/test-sections',
        asOwner({ suiteId: otherSuite, name: 'Filters' }),
      );
      const alsoRejected = await createCase(suiteId, { sectionId: foreignSection.json().id });
      expect(alsoRejected.statusCode).toBe(400);

      expect((await createCase(suiteId)).json().key).toBe('WEB-C-2');
    });

    it('numbers cases and requirements from separate counters', async () => {
      const suiteId = (await createSuite()).json().id;

      const requirement = await request(
        'POST',
        '/api/v1/requirements',
        asOwner({ projectId: workspace.projectId, title: 'The user can pay' }),
      );
      const testCase = await createCase(suiteId);

      expect(requirement.json().key).toBe('WEB-R-1');
      expect(testCase.json().key).toBe('WEB-C-1');
    });
  });

  describe('duplication', () => {
    it('duplicates an archived case into an unarchived copy', async () => {
      const suiteId = (await createSuite()).json().id;
      const id = (await createCase(suiteId, { steps: [{ action: 'Open the cart' }] })).json().id;
      await request('POST', `/api/v1/test-cases/${id}/archive`, asOwner({}));

      const copy = await request('POST', `/api/v1/test-cases/${id}/duplicate`, asOwner({}));

      // Duplicating is how a team revives an old case: the copy has to be
      // usable, so it does not inherit the archive.
      expect(copy.statusCode).toBe(201);
      expect(copy.json().archivedAt).toBeNull();
      expect(copy.json().status).toBe('draft');
      expect(copy.json().steps).toHaveLength(1);
    });

    it('duplicates into another section of the same suite', async () => {
      const suiteId = (await createSuite()).json().id;
      const origin = await request(
        'POST',
        '/api/v1/test-sections',
        asOwner({ suiteId, name: 'Cart' }),
      );
      const target = await request(
        'POST',
        '/api/v1/test-sections',
        asOwner({ suiteId, name: 'Payment' }),
      );
      const id = (await createCase(suiteId, { sectionId: origin.json().id })).json().id;

      const copy = await request(
        'POST',
        `/api/v1/test-cases/${id}/duplicate`,
        asOwner({ sectionId: target.json().id, title: 'Pay with an expired card' }),
      );

      expect(copy.json().sectionId).toBe(target.json().id);
      expect(copy.json().title).toBe('Pay with an expired card');
    });

    it('refuses to duplicate into a section of another suite', async () => {
      const suiteId = (await createSuite('Checkout')).json().id;
      const otherSuite = (await createSuite('Search')).json().id;
      const foreignSection = await request(
        'POST',
        '/api/v1/test-sections',
        asOwner({ suiteId: otherSuite, name: 'Filters' }),
      );
      const id = (await createCase(suiteId)).json().id;

      const response = await request(
        'POST',
        `/api/v1/test-cases/${id}/duplicate`,
        asOwner({ sectionId: foreignSection.json().id }),
      );

      expect(response.statusCode).toBe(400);
    });
  });

  describe('audit', () => {
    const entriesFor = (entityId: string) =>
      prisma.auditLog.findMany({
        where: { entityType: 'TestCase', entityId },
        orderBy: { createdAt: 'asc' },
      });

    it('records archiving and restoring with the acting user', async () => {
      const suiteId = (await createSuite()).json().id;
      const id = (await createCase(suiteId)).json().id;

      await request('POST', `/api/v1/test-cases/${id}/archive`, asOwner({}));
      await request('POST', `/api/v1/test-cases/${id}/restore`, asOwner({}));

      const entries = await entriesFor(id);
      expect(entries.map((entry) => entry.action)).toEqual(['create', 'archive', 'restore']);
      expect(entries.every((entry) => entry.userId === workspace.owner.userId)).toBe(true);
      expect(entries.every((entry) => entry.organizationId === workspace.organizationId)).toBe(
        true,
      );
    });

    it('records a duplication against the copy, naming the source', async () => {
      const suiteId = (await createSuite()).json().id;
      const id = (await createCase(suiteId)).json().id;

      const copy = await request('POST', `/api/v1/test-cases/${id}/duplicate`, asOwner({}));

      const entries = await entriesFor(copy.json().id);
      expect(entries.map((entry) => entry.summary)).toEqual([
        'Duplicated WEB-C-1 as WEB-C-2',
      ]);
    });

    it('writes nothing when the operation was rejected', async () => {
      const suiteId = (await createSuite()).json().id;
      const id = (await createCase(suiteId)).json().id;
      await request('POST', `/api/v1/test-cases/${id}/archive`, asOwner({}));

      const again = await request('POST', `/api/v1/test-cases/${id}/archive`, asOwner({}));

      expect(again.statusCode).toBe(409);
      expect((await entriesFor(id)).filter((entry) => entry.action === 'archive')).toHaveLength(1);
    });
  });
});
