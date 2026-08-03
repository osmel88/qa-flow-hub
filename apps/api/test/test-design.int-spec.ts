import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Smoke coverage of the test design module while it is still being built: the
 * happy path plus the invariants that would be expensive to discover later.
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

  it('never exposes another organization’s suites', async () => {
    await createSuite();
    const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });

    const response = await request('GET', `/api/v1/test-suites?projectId=${workspace.projectId}`, {
      token: stranger.owner.accessToken,
      organizationId: stranger.organizationId,
    });

    expect(response.json()).toEqual([]);
  });
});
