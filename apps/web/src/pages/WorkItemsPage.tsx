import { PRIORITIES, WORK_ITEM_STATUSES, WORK_ITEM_TYPES } from '@qa-flow-hub/shared';
import type { WorkItemStatus, WorkItemType } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { workItemsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';

export const WORK_ITEM_TONE: Record<WorkItemStatus, BadgeTone> = {
  backlog: 'neutral',
  ready: 'info',
  in_progress: 'info',
  blocked: 'danger',
  in_review: 'warning',
  done: 'success',
  cancelled: 'neutral',
};

/** "payments, UX" → ['payments', 'UX']; the API normalises case and duplicates. */
export function parseLabels(value: string): string[] {
  return value
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '');
}

export function WorkItemsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<WorkItemType>('story');
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('medium');
  const [estimate, setEstimate] = useState('');
  const [labels, setLabels] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<WorkItemType | ''>('');
  const [filterStatus, setFilterStatus] = useState<WorkItemStatus | ''>('');
  const [search, setSearch] = useState('');

  const projectId = activeProjectId ?? '';
  const trimmedSearch = search.trim();

  const items = useQuery({
    queryKey: ['work-items', activeProjectId, filterType, filterStatus, trimmedSearch],
    queryFn: () =>
      workItemsApi.list({
        projectId,
        ...(filterType === '' ? {} : { type: filterType }),
        ...(filterStatus === '' ? {} : { status: filterStatus }),
        ...(trimmedSearch === '' ? {} : { search: trimmedSearch }),
      }),
    enabled: activeProjectId !== null,
  });

  const create = useMutation({
    mutationFn: () =>
      workItemsApi.create({
        projectId,
        title: title.trim(),
        type,
        status: 'backlog',
        priority,
        estimate: estimate.trim() === '' ? null : Number(estimate),
        labels: parseLabels(labels),
      }),
    onSuccess: async () => {
      setTitle('');
      setEstimate('');
      setLabels('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['work-items'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('workItems.couldNotCreateTheWork'));
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <>
      <PageHeader
        title={t('workItems.workItems')}
        description={t('workItems.theProjectBacklogEpicsFeatures')}
      />

      {can('work_items.write') && (
        <section className="card" aria-labelledby="new-work-item">
          <h2 id="new-work-item">{t('workItems.newWorkItem')}</h2>
          {error !== null && (
            <p className="ui-field__error" role="alert">
              {error}
            </p>
          )}
          <div className="form-grid">
            <TextField
              label={t('workItems.title')}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
            <SelectField
              label={t('workItems.type')}
              value={type}
              options={WORK_ITEM_TYPES.map((value) => ({ value, label: humanize(value) }))}
              onChange={(event) => {
                setType(event.target.value as WorkItemType);
              }}
            />
            <SelectField
              label={t('workItems.priority')}
              value={priority}
              options={PRIORITIES.map((value) => ({ value, label: humanize(value) }))}
              onChange={(event) => {
                setPriority(event.target.value as (typeof PRIORITIES)[number]);
              }}
            />
            <TextField
              label={t('workItems.estimate')}
              type="number"
              min={0}
              step={0.5}
              value={estimate}
              onChange={(event) => {
                setEstimate(event.target.value);
              }}
            />
            <TextField
              label={t('workItems.labels')}
              hint={t('workItems.commaSeparated')}
              value={labels}
              onChange={(event) => {
                setLabels(event.target.value);
              }}
            />
          </div>
          <Button
            loading={create.isPending}
            disabled={title.trim().length < 3}
            onClick={() => {
              create.mutate();
            }}
          >
            {t('workItems.addWorkItem')}
          </Button>
        </section>
      )}

      <section className="card filters" aria-label={t('workItems.filters')}>
        <SelectField
          label={t('workItems.filterByType')}
          value={filterType}
          options={[
            { value: '', label: t('workItems.anyType') },
            ...WORK_ITEM_TYPES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setFilterType(event.target.value as WorkItemType | '');
          }}
        />
        <SelectField
          label={t('workItems.filterByStatus')}
          value={filterStatus}
          options={[
            { value: '', label: t('workItems.anyStatus') },
            ...WORK_ITEM_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setFilterStatus(event.target.value as WorkItemStatus | '');
          }}
        />
        <TextField
          label={t('workItems.search')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </section>

      <DataState
        isPending={items.isPending}
        error={items.error}
        isEmpty={(items.data?.data.length ?? 0) === 0}
        emptyMessage={t('workItems.noWorkItemMatches')}
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">{t('workItems.key')}</th>
              <th scope="col">{t('workItems.title')}</th>
              <th scope="col">{t('workItems.type')}</th>
              <th scope="col">{t('workItems.status')}</th>
              <th scope="col">{t('workItems.priority')}</th>
              <th scope="col">{t('workItems.estimate')}</th>
              <th scope="col">{t('workItems.labels')}</th>
            </tr>
          </thead>
          <tbody>
            {items.data?.data.map((item) => (
              <tr key={item.id}>
                <td>
                  <code>{item.key}</code>
                </td>
                <td>
                  <Link to={`/work-items/${item.id}`}>{item.title}</Link>
                </td>
                <td>{humanize(item.type)}</td>
                <td>
                  <Badge tone={WORK_ITEM_TONE[item.status]}>{humanize(item.status)}</Badge>
                </td>
                <td>{humanize(item.priority)}</td>
                <td>{item.estimate ?? t('workItems.none')}</td>
                <td className="muted">{item.labels.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
