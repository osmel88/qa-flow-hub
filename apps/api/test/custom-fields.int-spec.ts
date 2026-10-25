import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Custom fields and the defect workflow (S3-F7), with the API connected as
 * `qaflow_app` so the new tables are under Row Level Security.
 */
describe('Custom fields and defect workflow', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let acme: TestWorkspace;
  let globex: TestWorkspace;

  const request = injector(() => app);

  const ownerUrl = (): string =>
    process.env['TEST_DATABASE_URL'] ??
    'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public';

  const appRoleUrl = (): string => {
    const url = new URL(ownerUrl());
    url.username = 'qaflow_app';
    url.password = process.env['TEST_APP_DATABASE_PASSWORD'] ?? 'qaflow_app_test';
    return url.toString();
  };

  const truncate = async (): Promise<void> => {
    const tables = await owner.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;
    const list = tables.map((row) => `"${row.tablename}"`).join(', ');
    await owner.$executeRawUnsafe(`ALTER TABLE "audit_logs" DISABLE TRIGGER USER`);
    try {
      await owner.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    } finally {
      await owner.$executeRawUnsafe(`ALTER TABLE "audit_logs" ENABLE TRIGGER USER`);
    }
  };

  const as = (account: TestAccount, payload?: object, workspace: TestWorkspace = acme) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: workspace.organizationId,
  });

  interface Field {
    id: string;
    options: Array<{ id: string; label: string; archived: boolean }>;
  }

  const createField = async (payload: object, workspace: TestWorkspace = acme): Promise<Field> => {
    const response = await request(
      'POST',
      '/api/v1/custom-fields',
      as(
        workspace.owner,
        { projectId: workspace.projectId, entityType: 'defect', ...payload },
        workspace,
      ),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };

  const createDefect = (
    customFields: object,
    account: TestAccount = acme.owner,
    workspace: TestWorkspace = acme,
  ) =>
    request(
      'POST',
      '/api/v1/defects',
      as(
        account,
        {
          projectId: workspace.projectId,
          title: 'Checkout breaks',
          severity: 'major',
          customFields,
        },
        workspace,
      ),
    );

  const move = (id: string, status: string, account: TestAccount = acme.owner) =>
    request('POST', `/api/v1/defects/${id}/status`, as(account, { status }));

  const workflow = async (): Promise<{
    version: number;
    customized: boolean;
    transitions: Array<{ from: string; to: string }>;
  }> =>
    (
      await request('GET', `/api/v1/defect-workflow?projectId=${acme.projectId}`, as(acme.owner))
    ).json();

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
    app = await createTestApp({ databaseUrl: appRoleUrl() });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  beforeEach(async () => {
    await truncate();
    acme = await createWorkspace(app, { emailPrefix: 'acme-owner', slug: 'acme' });
    globex = await createWorkspace(app, {
      emailPrefix: 'globex-owner',
      slug: 'globex',
      projectKey: 'GLX',
    });
  });

  describe('definitions and values', () => {
    it('validates, stores, filters and audits defect values', async () => {
      const browser = await createField({
        key: 'browser',
        label: 'Browser',
        type: 'select',
        options: [{ label: 'Chrome' }, { label: 'Safari' }],
      });
      const build = await createField({
        key: 'build',
        label: 'Build',
        type: 'text',
        required: true,
      });
      const chrome = browser.options[0]?.id ?? '';

      const missing = await createDefect({ [browser.id]: chrome });
      expect(missing.statusCode).toBe(400);
      expect(JSON.stringify(missing.json())).toContain('Build is required');

      const wrongType = await createDefect({ [build.id]: 42 });
      expect(wrongType.statusCode).toBe(400);

      const unknownOption = await createDefect({ [build.id]: '1.0', [browser.id]: 'opt_nope' });
      expect(unknownOption.statusCode).toBe(400);
      expect(await owner.defect.count()).toBe(0);

      const created = await createDefect({ [build.id]: ' 1.0 ', [browser.id]: chrome });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().customFields).toEqual({ [build.id]: '1.0', [browser.id]: chrome });
      await createDefect({ [build.id]: '2.0' });

      const filtered = await request(
        'GET',
        `/api/v1/defects?projectId=${acme.projectId}&customField=${browser.id}&customFieldValue=${chrome}`,
        as(acme.owner),
      );
      expect(filtered.json().meta.total).toBe(1);
      const foreign = await createField({ key: 'browser', label: 'B', type: 'text' }, globex);
      const crossFilter = await request(
        'GET',
        `/api/v1/defects?projectId=${acme.projectId}&customField=${foreign.id}&customFieldValue=x`,
        as(acme.owner),
      );
      expect(crossFilter.statusCode).toBe(200);
      expect(crossFilter.json().meta.total).toBe(0);

      const audit = await owner.auditLog.findMany({
        where: { entityType: 'CustomFieldDefinition', organizationId: acme.organizationId },
      });
      expect(audit).toHaveLength(2);
    });

    it('merges patches, keeps archived options already chosen and audits the diff', async () => {
      const browser = await createField({
        key: 'browser',
        label: 'Browser',
        type: 'select',
        options: [{ label: 'Chrome' }, { label: 'Safari' }],
      });
      const notes = await createField({ key: 'notes', label: 'Notes', type: 'text' });
      const [chrome, safari] = browser.options.map((option) => option.id);
      const defect = (await createDefect({ [browser.id]: safari })).json();

      const archive = await request(
        'PATCH',
        `/api/v1/custom-fields/${browser.id}`,
        as(acme.owner, {
          options: [
            { id: chrome, label: 'Chrome' },
            { id: safari, label: 'Safari', archived: true },
          ],
        }),
      );
      expect(archive.statusCode, archive.body).toBe(200);

      expect((await createDefect({ [browser.id]: safari })).statusCode).toBe(400);
      const keep = await request(
        'PATCH',
        `/api/v1/defects/${defect.id}`,
        as(acme.owner, { customFields: { [notes.id]: 'seen on iOS' } }),
      );
      expect(keep.statusCode, keep.body).toBe(200);
      expect(keep.json().customFields).toEqual({ [browser.id]: safari, [notes.id]: 'seen on iOS' });

      const clear = await request(
        'PATCH',
        `/api/v1/defects/${defect.id}`,
        as(acme.owner, { customFields: { [notes.id]: null } }),
      );
      expect(clear.json().customFields).toEqual({ [browser.id]: safari });

      const drop = await request(
        'PATCH',
        `/api/v1/custom-fields/${browser.id}`,
        as(acme.owner, { options: [{ id: chrome, label: 'Chrome' }] }),
      );
      expect(drop.statusCode).toBe(400);

      const audit = await owner.auditLog.findFirst({
        where: { entityType: 'Defect', entityId: defect.id, summary: { startsWith: 'Updated' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(JSON.stringify(audit?.changes)).toContain('seen on iOS');
    });

    it('stops accepting writes to an archived field but keeps its values', async () => {
      const notes = await createField({ key: 'notes', label: 'Notes', type: 'text' });
      const defect = (await createDefect({ [notes.id]: 'kept' })).json();
      const archived = await request(
        'POST',
        `/api/v1/custom-fields/${notes.id}/archive`,
        as(acme.owner),
      );
      expect(archived.statusCode).toBe(200);
      const write = await request(
        'PATCH',
        `/api/v1/defects/${defect.id}`,
        as(acme.owner, { customFields: { [notes.id]: 'new' } }),
      );
      expect(write.statusCode).toBe(400);
      const read = await request('GET', `/api/v1/defects/${defect.id}`, as(acme.owner));
      expect(read.json().customFields).toEqual({ [notes.id]: 'kept' });
      const active = await request(
        'GET',
        `/api/v1/custom-fields?projectId=${acme.projectId}`,
        as(acme.owner),
      );
      expect(active.json()).toHaveLength(0);
    });

    it('applies to requirements and test cases with their own definitions', async () => {
      const risk = await createField({
        entityType: 'requirement',
        key: 'risk',
        label: 'Risk',
        type: 'number',
        required: true,
      });
      const defectField = await createField({ key: 'risk', label: 'Risk', type: 'number' });
      const requirement = await request(
        'POST',
        '/api/v1/requirements',
        as(acme.owner, {
          projectId: acme.projectId,
          title: 'Pay by card',
          customFields: { [risk.id]: 3 },
        }),
      );
      expect(requirement.statusCode, requirement.body).toBe(201);
      expect(requirement.json().customFields).toEqual({ [risk.id]: 3 });
      const wrongEntity = await request(
        'POST',
        '/api/v1/requirements',
        as(acme.owner, {
          projectId: acme.projectId,
          title: 'Pay by cash',
          customFields: { [risk.id]: 1, [defectField.id]: 1 },
        }),
      );
      expect(wrongEntity.statusCode).toBe(400);

      const automated = await createField({
        entityType: 'test_case',
        key: 'automated_in',
        label: 'Automated in',
        type: 'multi_select',
        options: [{ label: 'Playwright' }, { label: 'Cypress' }],
      });
      const suite = await request(
        'POST',
        '/api/v1/test-suites',
        as(acme.owner, { projectId: acme.projectId, name: 'Checkout' }),
      );
      const testCase = (
        await request(
          'POST',
          '/api/v1/test-cases',
          as(acme.owner, { suiteId: suite.json().id, title: 'Card payment' }),
        )
      ).json();
      const playwright = automated.options[0]?.id ?? '';
      const updated = await request(
        'PATCH',
        `/api/v1/test-cases/${testCase.id}`,
        as(acme.owner, { customFields: { [automated.id]: [playwright, playwright] } }),
      );
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json().customFields).toEqual({ [automated.id]: [playwright] });
      const filtered = await request(
        'GET',
        `/api/v1/test-cases?projectId=${acme.projectId}&customField=${automated.id}&customFieldValue=${playwright}`,
        as(acme.owner),
      );
      expect(filtered.json().meta.total).toBe(1);
    });

    it('rejects duplicate keys, including two concurrent creates', async () => {
      const payload = {
        projectId: acme.projectId,
        entityType: 'defect',
        key: 'browser',
        label: 'Browser',
        type: 'text',
      };
      const responses = await Promise.all(
        [1, 2, 3].map(() => request('POST', '/api/v1/custom-fields', as(acme.owner, payload))),
      );
      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409, 409]);
      // The same key on another entity is a different field.
      await createField({ entityType: 'requirement', key: 'browser', label: 'B', type: 'text' });
    });
  });

  describe('isolation and permissions', () => {
    it('hides definitions of another tenant or a hidden project', async () => {
      const field = await createField({ key: 'browser', label: 'Browser', type: 'text' });
      for (const [method, url] of [
        ['GET', `/api/v1/custom-fields/${field.id}`],
        ['PATCH', `/api/v1/custom-fields/${field.id}`],
        ['POST', `/api/v1/custom-fields/${field.id}/archive`],
      ] as const) {
        const response = await request(method, url, as(globex.owner, { label: 'x' }, globex));
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
      const list = await request(
        'GET',
        `/api/v1/custom-fields?projectId=${acme.projectId}`,
        as(globex.owner, undefined, globex),
      );
      expect(list.json()).toEqual([]);
      // Another tenant's definition id is an unknown field, never a value.
      const borrowed = await createDefect({ [field.id]: 'x' }, globex.owner, globex);
      expect(borrowed.statusCode).toBe(400);
      expect(await owner.defect.count()).toBe(0);

      const outsider = await acme.addMember('tester', 'outsider', { projectAccess: false });
      const hidden = await request('GET', `/api/v1/custom-fields/${field.id}`, as(outsider));
      expect(hidden.statusCode).toBe(404);
      const hiddenWorkflow = await request(
        'GET',
        `/api/v1/defect-workflow?projectId=${acme.projectId}`,
        as(outsider),
      );
      expect(hiddenWorkflow.statusCode).toBe(404);
    });

    it('lets only customization.manage define fields and workflows', async () => {
      const tester = await acme.addMember('tester');
      const create = await request(
        'POST',
        '/api/v1/custom-fields',
        as(tester, {
          projectId: acme.projectId,
          entityType: 'defect',
          key: 'k',
          label: 'K',
          type: 'text',
        }),
      );
      expect(create.statusCode).toBe(403);
      const current = await workflow();
      const put = await request(
        'PUT',
        '/api/v1/defect-workflow',
        as(tester, { projectId: acme.projectId, version: 0, transitions: current.transitions }),
      );
      expect(put.statusCode).toBe(403);
      const read = await request(
        'GET',
        `/api/v1/custom-fields?projectId=${acme.projectId}`,
        as(tester),
      );
      expect(read.statusCode).toBe(200);
      expect(await owner.customFieldDefinition.count()).toBe(0);
    });
  });

  describe('defect workflow', () => {
    it('defaults to the built-in graph and enforces a configured one', async () => {
      const initial = await workflow();
      expect(initial).toMatchObject({ version: 0, customized: false });
      expect(initial.transitions).toHaveLength(16);

      const rootCause = await createField({ key: 'root_cause', label: 'Root cause', type: 'text' });
      const trapping = await request(
        'PUT',
        '/api/v1/defect-workflow',
        as(acme.owner, {
          projectId: acme.projectId,
          version: 0,
          transitions: [{ from: 'open', to: 'closed' }],
        }),
      );
      expect(trapping.statusCode).toBe(400);

      const transitions = [
        { from: 'open', to: 'triaged' },
        {
          from: 'triaged',
          to: 'closed',
          permission: 'defects.manage',
          requiredFieldIds: [rootCause.id],
        },
        { from: 'triaged', to: 'rejected' },
        { from: 'in_progress', to: 'closed' },
        { from: 'resolved', to: 'closed' },
        { from: 'closed', to: 'reopened' },
        { from: 'rejected', to: 'reopened' },
        { from: 'reopened', to: 'triaged' },
      ];
      const saved = await request(
        'PUT',
        '/api/v1/defect-workflow',
        as(acme.owner, { projectId: acme.projectId, version: 0, transitions }),
      );
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({ version: 1, customized: true });

      const tester = await acme.addMember('tester');
      const defect = (await createDefect({}, tester)).json();
      expect((await move(defect.id, 'in_progress')).statusCode).toBe(409);
      expect((await move(defect.id, 'triaged', tester)).statusCode).toBe(200);
      expect((await move(defect.id, 'closed', tester)).statusCode).toBe(403);
      const noCause = await move(defect.id, 'closed');
      expect(noCause.statusCode).toBe(400);
      expect(noCause.json().error.message).toContain('Root cause');
      await request(
        'PATCH',
        `/api/v1/defects/${defect.id}`,
        as(acme.owner, { customFields: { [rootCause.id]: 'Null price' } }),
      );
      const closed = await move(defect.id, 'closed');
      expect(closed.statusCode, closed.body).toBe(200);
      expect(closed.json().closedAt).not.toBeNull();

      const unknownField = await request(
        'PUT',
        '/api/v1/defect-workflow',
        as(acme.owner, {
          projectId: acme.projectId,
          version: 1,
          transitions: transitions.map((item) => ({ ...item, requiredFieldIds: ['cf_nope'] })),
        }),
      );
      expect(unknownField.statusCode).toBe(400);

      const audit = await owner.auditLog.count({ where: { entityType: 'DefectWorkflow' } });
      expect(audit).toBe(1);
    });

    it('lets one of two concurrent saves of the same version win', async () => {
      const current = await workflow();
      const responses = await Promise.all(
        [1, 2, 3].map(() =>
          request(
            'PUT',
            '/api/v1/defect-workflow',
            as(acme.owner, {
              projectId: acme.projectId,
              version: 0,
              transitions: current.transitions,
            }),
          ),
        ),
      );
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409, 409]);
      expect((await workflow()).version).toBe(1);
      const stale = await request(
        'PUT',
        '/api/v1/defect-workflow',
        as(acme.owner, { projectId: acme.projectId, version: 0, transitions: current.transitions }),
      );
      expect(stale.statusCode).toBe(409);
    });

    it('serialises concurrent moves of the same defect', async () => {
      const defect = (await createDefect({})).json();
      const responses = await Promise.all([1, 2, 3].map(() => move(defect.id, 'triaged')));
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409, 409]);
      const moves = await owner.auditLog.count({
        where: { entityId: defect.id, summary: { startsWith: 'Moved' } },
      });
      expect(moves).toBe(1);
    });

    it('does not lose either of two concurrent patches of different fields', async () => {
      const a = await createField({ key: 'a', label: 'A', type: 'text' });
      const b = await createField({ key: 'b', label: 'B', type: 'text' });
      const defect = (await createDefect({})).json();
      const responses = await Promise.all([
        request(
          'PATCH',
          `/api/v1/defects/${defect.id}`,
          as(acme.owner, { customFields: { [a.id]: 'A' } }),
        ),
        request(
          'PATCH',
          `/api/v1/defects/${defect.id}`,
          as(acme.owner, { customFields: { [b.id]: 'B' } }),
        ),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      const stored = await owner.defect.findUniqueOrThrow({ where: { id: defect.id } });
      expect(stored.customFields).toEqual({ [a.id]: 'A', [b.id]: 'B' });
    });
  });
});
