import { computeEffectivePermissions } from '@qa-flow-hub/shared';
import type { OrganizationRoleName, WorkItemView } from '@qa-flow-hub/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '../test/render';

/**
 * Work items are listed for every role; only `work_items.write` sees the form,
 * and the form sends exactly what the API contract expects.
 */
const item: WorkItemView = {
  id: 'wi_1',
  projectId: 'proj_1',
  key: 'WEB-W-1',
  title: 'Pay with saved cards',
  description: null,
  type: 'story',
  status: 'in_progress',
  priority: 'high',
  assigneeId: null,
  reporterId: 'u_1',
  estimate: 5,
  labels: ['payments'],
  parentId: null,
  releaseId: null,
  sprintId: null,
  rank: 1024,
  version: 1,
  completedAt: null,
  createdAt: '2026-12-01T00:00:00.000Z',
  updatedAt: '2026-12-01T00:00:00.000Z',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubApi(role: OrganizationRoleName): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/permissions/me')) {
      return json({
        projectId: 'proj_1',
        userId: 'u_1',
        organizationRole: role,
        projectRole: null,
        hasAccess: true,
        effectiveRole: role,
        overrides: [],
        permissions: computeEffectivePermissions(role, []),
      });
    }
    if (url.includes('/work-items') && init?.method === 'POST') {
      return json({ ...item, id: 'wi_2', key: 'WEB-W-2' }, 201);
    }
    if (url.includes('/work-items')) {
      return json({ data: [item], meta: { page: 1, pageSize: 100, total: 1, totalPages: 1 } });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../project/project-context');
});

async function renderPage(): Promise<void> {
  vi.doMock('../project/project-context', () => ({
    useProject: () => ({ activeProjectId: 'proj_1', activeProject: { id: 'proj_1', key: 'WEB' } }),
  }));
  const { WorkItemsPage } = await import('./WorkItemsPage');
  renderScreen(<WorkItemsPage />);
}

describe('WorkItemsPage', () => {
  it('hides the form from a viewer but lists the backlog', async () => {
    stubApi('viewer');
    await renderPage();
    expect(await screen.findByRole('link', { name: 'Pay with saved cards' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Add work item' })).toBeNull();
    });
  });

  it('sends type, priority, estimate and labels from the form', async () => {
    const fetchMock = stubApi('tester');
    await renderPage();
    const button = await screen.findByRole('button', { name: 'Add work item' });
    await userEvent.type(screen.getByLabelText('Title'), 'Refund flow');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'epic');
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'critical');
    await userEvent.type(screen.getByLabelText('Estimate'), '8');
    await userEvent.type(screen.getByLabelText('Labels'), 'payments, UX');
    await userEvent.click(button);
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        projectId: 'proj_1',
        title: 'Refund flow',
        type: 'epic',
        status: 'backlog',
        priority: 'critical',
        estimate: 8,
        labels: ['payments', 'UX'],
      });
    });
  });

  it('splits labels on commas and drops blanks', async () => {
    const { parseLabels } = await import('./WorkItemsPage');
    expect(parseLabels(' a, ,b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(parseLabels('')).toEqual([]);
  });
});
