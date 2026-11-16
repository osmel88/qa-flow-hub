import type { DevelopmentStatus } from '@qa-flow-hub/shared';
import {
  BACKLOG_GROUPINGS,
  PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  isOpenRelease,
} from '@qa-flow-hub/shared';
import type {
  BacklogGrouping,
  BulkUpdateWorkItemsInput,
  WorkItemType,
  WorkItemView,
} from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { backlogApi, projectsApi, releasesApi, workItemsApi, sprintsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import {
  DEVELOPMENT_STATUS_OPTIONS,
  DevelopmentStatusBadge,
} from '../components/DevelopmentStatusBadge';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { WORK_ITEM_TONE, parseLabels } from './WorkItemsPage';
import { t } from '../i18n/i18n';

type Move = { id: string; beforeId: string } | { id: string; afterId: string };

/** Where a dragged row lands: dropping on a row below it means "after", above it "before". */
export function dropMove(
  order: readonly string[],
  draggedId: string,
  targetId: string,
): Move | null {
  const from = order.indexOf(draggedId);
  const to = order.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) {
    return null;
  }
  return from < to ? { id: draggedId, afterId: targetId } : { id: draggedId, beforeId: targetId };
}

function totalsText(totals: { count: number; estimate: number; unestimated: number }): string {
  return t('backlog.itemsEstimatedUnestimated', {
    count: totals.count,
    estimate: totals.estimate,
    unestimated: totals.unestimated,
  });
}

export function BacklogPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const [groupBy, setGroupBy] = useState<BacklogGrouping>('none');
  const [releaseId, setReleaseId] = useState('');
  const [sprintId, setSprintId] = useState('');
  const [type, setType] = useState<WorkItemType | ''>('');
  const [mine, setMine] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [search, setSearch] = useState('');
  const [developmentStatus, setDevelopmentStatus] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dragged, setDragged] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkPriority, setBulkPriority] = useState('');
  const [bulkAssignee, setBulkAssignee] = useState('');
  const [bulkRelease, setBulkRelease] = useState('');
  const [bulkEstimate, setBulkEstimate] = useState('');
  const [bulkLabels, setBulkLabels] = useState('');

  const projectId = activeProjectId ?? '';
  const editable = can('work_items.write');
  const trimmedSearch = search.trim();

  const backlog = useQuery({
    queryKey: [
      'backlog',
      activeProjectId,
      groupBy,
      releaseId,
      sprintId,
      type,
      mine,
      includeClosed,
      trimmedSearch,
      developmentStatus,
    ],
    queryFn: () =>
      backlogApi.get({
        projectId,
        groupBy,
        includeClosed: includeClosed ? 'true' : 'false',
        ...(releaseId === '' ? {} : { releaseId }),
        ...(sprintId === '' ? {} : { sprintId }),
        ...(type === '' ? {} : { type }),
        ...(mine ? { assigneeId: 'me' } : {}),
        ...(trimmedSearch === '' ? {} : { search: trimmedSearch }),
        ...(developmentStatus === ''
          ? {}
          : { developmentStatus: developmentStatus as DevelopmentStatus }),
      }),
    enabled: activeProjectId !== null,
  });
  const sprints = useQuery({
    queryKey: ['sprints', activeProjectId, 'filter'],
    queryFn: () => sprintsApi.list({ projectId }),
    enabled: activeProjectId !== null,
  });
  const releases = useQuery({
    queryKey: ['releases', activeProjectId, ''],
    queryFn: () => releasesApi.list({ projectId }),
    enabled: activeProjectId !== null,
  });
  const members = useQuery({
    queryKey: ['projects', activeProjectId, 'members'],
    queryFn: () => projectsApi.members(projectId),
    enabled: activeProjectId !== null && editable,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['backlog'] });
    await queryClient.invalidateQueries({ queryKey: ['work-items'] });
  };
  const failed = (fallback: string) => (cause: unknown) => {
    setError(cause instanceof ApiError ? cause.message : fallback);
  };

  const move = useMutation({
    mutationFn: ({ id, ...anchor }: Move) => workItemsApi.move(id, anchor),
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: failed(t('backlog.couldNotReorderTheBacklog')),
  });

  const bulk = useMutation({
    mutationFn: () => {
      const changes: BulkUpdateWorkItemsInput['changes'] = {
        ...(bulkStatus === '' ? {} : { status: bulkStatus as WorkItemView['status'] }),
        ...(bulkPriority === '' ? {} : { priority: bulkPriority as (typeof PRIORITIES)[number] }),
        ...(bulkAssignee === ''
          ? {}
          : { assigneeId: bulkAssignee === 'none' ? null : bulkAssignee }),
        ...(bulkRelease === '' ? {} : { releaseId: bulkRelease === 'none' ? null : bulkRelease }),
        ...(bulkEstimate.trim() === '' ? {} : { estimate: Number(bulkEstimate) }),
        ...(bulkLabels.trim() === '' ? {} : { addLabels: parseLabels(bulkLabels) }),
      };
      return workItemsApi.bulk({ projectId, ids: [...selected], changes });
    },
    onSuccess: async () => {
      setError(null);
      setSelected(new Set());
      setBulkStatus('');
      setBulkPriority('');
      setBulkAssignee('');
      setBulkRelease('');
      setBulkEstimate('');
      setBulkLabels('');
      await refresh();
    },
    onError: failed(t('backlog.couldNotUpdateTheSelected')),
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  const items = backlog.data?.items ?? [];
  const order = items.map((item) => item.id);
  const byId = new Map(items.map((item) => [item.id, item]));
  const sections =
    groupBy === 'none' || backlog.data === undefined
      ? [{ id: 'all', title: null, totals: null, items }]
      : backlog.data.groups.map((group) => ({
          id: group.id ?? 'none',
          title: group.key === null ? group.title : `${group.key} ${group.title}`,
          totals: group.totals,
          items: group.itemIds.flatMap((id) => byId.get(id) ?? []),
        }));
  const hasBulkChange =
    bulkStatus !== '' ||
    bulkPriority !== '' ||
    bulkAssignee !== '' ||
    bulkRelease !== '' ||
    bulkEstimate.trim() !== '' ||
    bulkLabels.trim() !== '';

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <>
      <PageHeader title={t('backlog.backlog')} description={t('backlog.theProjectSWorkIn')} />

      <section className="card filters" aria-label={t('backlog.backlogFilters')}>
        <SelectField
          label={t('backlog.groupBy')}
          value={groupBy}
          options={BACKLOG_GROUPINGS.map((value) => ({
            value,
            label: value === 'none' ? t('backlog.noGrouping') : humanize(value),
          }))}
          onChange={(event) => {
            setGroupBy(event.target.value as BacklogGrouping);
          }}
        />
        <SelectField
          label={t('backlog.releaseFilter')}
          value={releaseId}
          options={[
            { value: '', label: t('backlog.anyRelease') },
            { value: 'none', label: t('backlog.noRelease') },
            ...(releases.data?.data ?? []).map((release) => ({
              value: release.id,
              label: `${release.name} (${release.version})`,
            })),
          ]}
          onChange={(event) => {
            setReleaseId(event.target.value);
          }}
        />
        <SelectField
          label={t('backlog.sprintFilter')}
          value={sprintId}
          options={[
            { value: '', label: t('backlog.anySprint') },
            { value: 'none', label: t('backlog.notInASprint') },
            ...(sprints.data?.data ?? []).map((sprint) => ({
              value: sprint.id,
              label: `${sprint.name} (${humanize(sprint.status)})`,
            })),
          ]}
          onChange={(event) => {
            setSprintId(event.target.value);
          }}
        />
        <SelectField
          label={t('backlog.developmentFilter')}
          value={developmentStatus}
          options={DEVELOPMENT_STATUS_OPTIONS}
          onChange={(event) => {
            setDevelopmentStatus(event.target.value);
          }}
        />
        <SelectField
          label={t('backlog.typeFilter')}
          value={type}
          options={[
            { value: '', label: t('backlog.anyType') },
            ...WORK_ITEM_TYPES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setType(event.target.value as WorkItemType | '');
          }}
        />
        <TextField
          label={t('backlog.searchBacklog')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={mine}
            onChange={(event) => {
              setMine(event.target.checked);
            }}
          />
          {t('backlog.onlyMyItems')}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(event) => {
              setIncludeClosed(event.target.checked);
            }}
          />
          {t('backlog.includeDoneAndCancelled')}
        </label>
      </section>

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {backlog.data !== undefined && (
        <p className="muted" data-testid="backlog-totals">
          {totalsText(backlog.data.totals)}
          {backlog.data.truncated && t('backlog.showingTheFirst500')}
        </p>
      )}

      {editable && selected.size > 0 && (
        <section className="card" aria-labelledby="bulk-actions">
          <h2 id="bulk-actions">
            {t('backlog.change')} {selected.size} {t('backlog.selected')}
          </h2>
          <div className="form-grid">
            <SelectField
              label={t('backlog.setStatus')}
              value={bulkStatus}
              options={[
                { value: '', label: t('backlog.keep') },
                ...WORK_ITEM_STATUSES.map((value) => ({ value, label: humanize(value) })),
              ]}
              onChange={(event) => {
                setBulkStatus(event.target.value);
              }}
            />
            <SelectField
              label={t('backlog.setPriority')}
              value={bulkPriority}
              options={[
                { value: '', label: t('backlog.keep') },
                ...PRIORITIES.map((value) => ({ value, label: humanize(value) })),
              ]}
              onChange={(event) => {
                setBulkPriority(event.target.value);
              }}
            />
            <SelectField
              label={t('backlog.setAssignee')}
              value={bulkAssignee}
              options={[
                { value: '', label: t('backlog.keep') },
                { value: 'none', label: t('backlog.unassigned') },
                ...(members.data?.data ?? [])
                  .filter((member) => member.hasAccess)
                  .map((member) => ({ value: member.userId, label: member.fullName })),
              ]}
              onChange={(event) => {
                setBulkAssignee(event.target.value);
              }}
            />
            <SelectField
              label={t('backlog.setRelease')}
              value={bulkRelease}
              options={[
                { value: '', label: t('backlog.keep') },
                { value: 'none', label: t('backlog.noRelease') },
                ...(releases.data?.data ?? [])
                  .filter((release) => isOpenRelease(release.status))
                  .map((release) => ({
                    value: release.id,
                    label: `${release.name} (${release.version})`,
                  })),
              ]}
              onChange={(event) => {
                setBulkRelease(event.target.value);
              }}
            />
            <TextField
              label={t('backlog.setEstimate')}
              type="number"
              min={0}
              step={0.5}
              value={bulkEstimate}
              onChange={(event) => {
                setBulkEstimate(event.target.value);
              }}
            />
            <TextField
              label={t('backlog.addLabels')}
              hint={t('backlog.commaSeparated')}
              value={bulkLabels}
              onChange={(event) => {
                setBulkLabels(event.target.value);
              }}
            />
          </div>
          <div className="row-actions">
            <Button
              loading={bulk.isPending}
              disabled={!hasBulkChange}
              onClick={() => {
                bulk.mutate();
              }}
            >
              {t('backlog.applyTo')} {selected.size} {t('backlog.items')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setSelected(new Set());
              }}
            >
              {t('backlog.clearSelection')}
            </Button>
          </div>
        </section>
      )}

      <DataState
        isPending={backlog.isPending}
        error={backlog.error}
        isEmpty={items.length === 0}
        emptyMessage={t('backlog.theBacklogIsEmptyFor')}
      >
        <table className="table card" aria-label={t('backlog.backlog')}>
          <thead>
            <tr>
              {editable && <th scope="col">{t('backlog.select')}</th>}
              <th scope="col">{t('backlog.key')}</th>
              <th scope="col">{t('backlog.title')}</th>
              <th scope="col">{t('backlog.type')}</th>
              <th scope="col">{t('backlog.status')}</th>
              <th scope="col">{t('backlog.priority')}</th>
              <th scope="col">{t('backlog.estimate')}</th>
              {editable && <th scope="col">{t('backlog.order')}</th>}
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => (
              <Fragment key={section.id}>
                {section.title !== null && section.totals !== null && (
                  <tr className="group-row">
                    <th scope="rowgroup" colSpan={editable ? 8 : 6}>
                      {section.title} <span className="muted">({totalsText(section.totals)})</span>
                    </th>
                  </tr>
                )}
                {section.items.map((item) => {
                  const position = order.indexOf(item.id);
                  const previous = position > 0 ? order[position - 1] : undefined;
                  const next = position < order.length - 1 ? order[position + 1] : undefined;
                  return (
                    <tr
                      key={item.id}
                      data-testid={`backlog-row-${item.key}`}
                      draggable={editable}
                      className={dragged === item.id ? 'dragging' : undefined}
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/plain', item.id);
                        event.dataTransfer.effectAllowed = 'move';
                        setDragged(item.id);
                      }}
                      onDragEnd={() => {
                        setDragged(null);
                      }}
                      onDragOver={(event) => {
                        if (editable) {
                          event.preventDefault();
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const id = event.dataTransfer.getData('text/plain') || dragged;
                        setDragged(null);
                        const planned = id === null ? null : dropMove(order, id, item.id);
                        if (planned !== null) {
                          move.mutate(planned);
                        }
                      }}
                    >
                      {editable && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={t('backlog.select2', { key: item.key })}
                            checked={selected.has(item.id)}
                            onChange={() => {
                              toggle(item.id);
                            }}
                          />
                        </td>
                      )}
                      <td>
                        <code>{item.key}</code>{' '}
                        <DevelopmentStatusBadge
                          status={backlog.data?.developmentStatuses[item.id]}
                          testId={`development-status-${item.key}`}
                        />
                      </td>
                      <td>
                        <Link to={`/work-items/${item.id}`}>{item.title}</Link>
                        {item.labels.length > 0 && (
                          <span className="muted"> · {item.labels.join(', ')}</span>
                        )}
                      </td>
                      <td>{humanize(item.type)}</td>
                      <td>
                        <Badge tone={WORK_ITEM_TONE[item.status]}>{humanize(item.status)}</Badge>
                      </td>
                      <td>{humanize(item.priority)}</td>
                      <td>{item.estimate ?? t('backlog.none')}</td>
                      {editable && (
                        <td>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('backlog.moveUp', { key: item.key })}
                            disabled={previous === undefined || move.isPending}
                            onClick={() => {
                              if (previous !== undefined) {
                                move.mutate({ id: item.id, beforeId: previous });
                              }
                            }}
                          >
                            ↑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('backlog.moveDown', { key: item.key })}
                            disabled={next === undefined || move.isPending}
                            onClick={() => {
                              if (next !== undefined) {
                                move.mutate({ id: item.id, afterId: next });
                              }
                            }}
                          >
                            ↓
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
