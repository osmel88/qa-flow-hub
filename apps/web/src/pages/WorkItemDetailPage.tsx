import {
  PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  canBeParentOf,
  isOpenRelease,
} from '@qa-flow-hub/shared';
import type { WorkItemDetailView, WorkItemStatus, WorkItemType } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { projectsApi, releasesApi, workItemsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { WORK_ITEM_TONE, parseLabels } from './WorkItemsPage';

interface Draft {
  title: string;
  description: string;
  type: WorkItemType;
  status: WorkItemStatus;
  priority: (typeof PRIORITIES)[number];
  estimate: string;
  labels: string;
  assigneeId: string;
  parentId: string;
  releaseId: string;
}

function draftOf(item: WorkItemDetailView): Draft {
  return {
    title: item.title,
    description: item.description ?? '',
    type: item.type,
    status: item.status,
    priority: item.priority as Draft['priority'],
    estimate: item.estimate === null ? '' : String(item.estimate),
    labels: item.labels.join(', '),
    assigneeId: item.assigneeId ?? '',
    parentId: item.parentId ?? '',
    releaseId: item.releaseId ?? '',
  };
}

export function WorkItemDetailPage(): React.JSX.Element {
  const { workItemId = '' } = useParams();
  const item = useQuery({
    queryKey: ['work-items', 'detail', workItemId],
    queryFn: () => workItemsApi.get(workItemId),
  });
  // Lives here: a save bumps `version`, which remounts the editor below.
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  return (
    <DataState isPending={item.isPending} error={item.error} isEmpty={false}>
      {item.data !== undefined && (
        <WorkItemEditor
          key={item.data.version}
          item={item.data}
          saved={savedVersion === item.data.version}
          onSaved={setSavedVersion}
        />
      )}
    </DataState>
  );
}

function WorkItemEditor({
  item,
  saved,
  onSaved,
}: {
  item: WorkItemDetailView;
  saved: boolean;
  onSaved: (version: number) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { can } = useProjectPermissions(item.projectId);
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [error, setError] = useState<string | null>(null);
  const editable = can('work_items.write');

  const members = useQuery({
    queryKey: ['projects', item.projectId, 'members'],
    queryFn: () => projectsApi.members(item.projectId),
    enabled: editable,
  });
  const releases = useQuery({
    queryKey: ['releases', item.projectId, ''],
    queryFn: () => releasesApi.list({ projectId: item.projectId }),
    enabled: editable,
  });
  const candidates = useQuery({
    queryKey: ['work-items', item.projectId, 'parents'],
    queryFn: () => workItemsApi.list({ projectId: item.projectId }),
    enabled: editable,
  });

  const set = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const save = useMutation({
    mutationFn: () =>
      workItemsApi.update(item.id, {
        version: item.version,
        title: draft.title.trim(),
        description: draft.description.trim() === '' ? null : draft.description.trim(),
        type: draft.type,
        status: draft.status,
        priority: draft.priority,
        estimate: draft.estimate.trim() === '' ? null : Number(draft.estimate),
        labels: parseLabels(draft.labels),
        assigneeId: draft.assigneeId === '' ? null : draft.assigneeId,
        parentId: draft.parentId === '' ? null : draft.parentId,
        ...(draft.releaseId === (item.releaseId ?? '')
          ? {}
          : { releaseId: draft.releaseId === '' ? null : draft.releaseId }),
      }),
    onSuccess: async (updated) => {
      setError(null);
      onSaved(updated.version);
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not save the work item.');
    },
  });

  const remove = useMutation({
    mutationFn: () => workItemsApi.remove(item.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
      await navigate('/work-items');
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not delete the work item.');
    },
  });

  // Only parents the hierarchy accepts, and never the item itself.
  const parents = (candidates.data?.data ?? []).filter(
    (candidate) => candidate.id !== item.id && canBeParentOf(candidate.type, draft.type),
  );
  const openReleases = (releases.data?.data ?? []).filter(
    (release) => isOpenRelease(release.status) || release.id === item.releaseId,
  );

  return (
    <>
      <PageHeader title={`${item.key} · ${item.title}`} description={humanize(item.type)} />
      {item.ancestors.length > 0 && (
        <nav aria-label="Ancestors" className="muted">
          {item.ancestors.map((ancestor, index) => (
            <span key={ancestor.id}>
              {index > 0 && ' › '}
              <Link to={`/work-items/${ancestor.id}`}>
                {ancestor.key} {ancestor.title}
              </Link>
            </span>
          ))}
        </nav>
      )}
      <p>
        <Badge tone={WORK_ITEM_TONE[item.status]}>{humanize(item.status)}</Badge>{' '}
        <span className="muted">
          Priority {humanize(item.priority)} · Estimate {item.estimate ?? 'none'} · Version{' '}
          {item.version}
        </span>
      </p>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">Work item saved.</p>}

      <section className="card" aria-labelledby="work-item-edit">
        <h2 id="work-item-edit">Details</h2>
        <div className="form-grid">
          <TextField
            label="Title"
            value={draft.title}
            disabled={!editable}
            onChange={(event) => {
              set({ title: event.target.value });
            }}
          />
          <TextField
            label="Description"
            value={draft.description}
            disabled={!editable}
            onChange={(event) => {
              set({ description: event.target.value });
            }}
          />
          <SelectField
            label="Type"
            value={draft.type}
            disabled={!editable}
            options={WORK_ITEM_TYPES.map((value) => ({ value, label: humanize(value) }))}
            onChange={(event) => {
              set({ type: event.target.value as WorkItemType });
            }}
          />
          <SelectField
            label="Status"
            value={draft.status}
            disabled={!editable}
            options={WORK_ITEM_STATUSES.map((value) => ({ value, label: humanize(value) }))}
            onChange={(event) => {
              set({ status: event.target.value as WorkItemStatus });
            }}
          />
          <SelectField
            label="Priority"
            value={draft.priority}
            disabled={!editable}
            options={PRIORITIES.map((value) => ({ value, label: humanize(value) }))}
            onChange={(event) => {
              set({ priority: event.target.value as Draft['priority'] });
            }}
          />
          <TextField
            label="Estimate"
            type="number"
            min={0}
            step={0.5}
            value={draft.estimate}
            disabled={!editable}
            onChange={(event) => {
              set({ estimate: event.target.value });
            }}
          />
          <TextField
            label="Labels"
            hint="Comma separated"
            value={draft.labels}
            disabled={!editable}
            onChange={(event) => {
              set({ labels: event.target.value });
            }}
          />
          <SelectField
            label="Assignee"
            value={draft.assigneeId}
            disabled={!editable}
            options={[
              { value: '', label: 'Unassigned' },
              ...(members.data?.data ?? [])
                .filter((member) => member.hasAccess)
                .map((member) => ({ value: member.userId, label: member.fullName })),
            ]}
            onChange={(event) => {
              set({ assigneeId: event.target.value });
            }}
          />
          <SelectField
            label="Parent"
            value={draft.parentId}
            disabled={!editable}
            options={[
              { value: '', label: 'No parent' },
              ...parents.map((parent) => ({
                value: parent.id,
                label: `${parent.key} ${parent.title}`,
              })),
            ]}
            onChange={(event) => {
              set({ parentId: event.target.value });
            }}
          />
          <SelectField
            label="Release"
            value={draft.releaseId}
            disabled={!editable}
            options={[
              { value: '', label: 'No release' },
              ...openReleases.map((release) => ({
                value: release.id,
                label: `${release.name} (${release.version})`,
              })),
            ]}
            onChange={(event) => {
              set({ releaseId: event.target.value });
            }}
          />
        </div>
        {editable && (
          <div className="row-actions">
            <Button
              loading={save.isPending}
              disabled={draft.title.trim().length < 3}
              onClick={() => {
                save.mutate();
              }}
            >
              Save changes
            </Button>
            {can('work_items.manage') && (
              <Button
                variant="secondary"
                loading={remove.isPending}
                onClick={() => {
                  remove.mutate();
                }}
              >
                Delete work item
              </Button>
            )}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="work-item-children">
        <h2 id="work-item-children">Children</h2>
        {item.children.length === 0 ? (
          <p className="muted">No child items.</p>
        ) : (
          <ul>
            {item.children.map((child) => (
              <li key={child.id}>
                <Link to={`/work-items/${child.id}`}>
                  {child.key} {child.title}
                </Link>{' '}
                <span className="muted">
                  {humanize(child.type)} · {humanize(child.status)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
