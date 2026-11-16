import type { DevelopmentStatus } from '@qa-flow-hub/shared';
import {
  BOARD_SWIMLANES,
  KANBAN_COLUMNS,
  PRIORITIES,
  WIP_LIMITED_COLUMNS,
  WORK_ITEM_TYPES,
  wipState,
} from '@qa-flow-hub/shared';
import type {
  BoardSwimlane,
  KanbanCard,
  KanbanColumnId,
  KanbanColumnView,
  KanbanQuery,
  KanbanView,
  MoveKanbanCardInput,
} from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { kanbanApi, releasesApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import {
  DEVELOPMENT_STATUS_OPTIONS,
  DevelopmentStatusBadge,
} from '../components/DevelopmentStatusBadge';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { dropPlacement } from './BoardPage';
import { NoProject } from './NoProject';
import { WORK_ITEM_TONE } from './WorkItemsPage';
import { t } from '../i18n/i18n';

type Placement = Pick<MoveKanbanCardInput, 'beforeId' | 'afterId'>;

/** Header text of a column: its size and, when set, its WIP limit. */
export function columnCount(column: Pick<KanbanColumnView, 'count' | 'wipLimit'>): string {
  return column.wipLimit === null ? `${column.count}` : `${column.count}/${column.wipLimit}`;
}

function formatDays(value: number | null): string {
  return value === null ? '—' : `${value} d`;
}

export function KanbanPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState('');
  const [type, setType] = useState('');
  const [epicId, setEpicId] = useState('');
  const [featureId, setFeatureId] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [search, setSearch] = useState('');
  const [developmentStatus, setDevelopmentStatus] = useState('');
  const [swimlane, setSwimlane] = useState<BoardSwimlane>('none');
  const [windowDays, setWindowDays] = useState(14);
  const [dragged, setDragged] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limits, setLimits] = useState<Record<string, string> | null>(null);
  const [saved, setSaved] = useState(false);
  const projectId = activeProjectId ?? '';
  const trimmed = search.trim();

  const params = {
    projectId,
    swimlane,
    windowDays,
    ...(assigneeId === '' ? {} : { assigneeId }),
    ...(priority === '' ? {} : { priority: priority as NonNullable<KanbanQuery['priority']> }),
    ...(type === '' ? {} : { type: type as NonNullable<KanbanQuery['type']> }),
    ...(epicId === '' ? {} : { epicId }),
    ...(featureId === '' ? {} : { featureId }),
    ...(releaseId === '' ? {} : { releaseId }),
    ...(trimmed === '' ? {} : { search: trimmed }),
    ...(developmentStatus === ''
      ? {}
      : { developmentStatus: developmentStatus as DevelopmentStatus }),
  };
  const board = useQuery({
    queryKey: ['kanban', params],
    queryFn: () => kanbanApi.board(params),
    enabled: activeProjectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const releases = useQuery({
    queryKey: ['releases', activeProjectId, 'kanban'],
    queryFn: () => releasesApi.list({ projectId }),
    enabled: activeProjectId !== null,
  });

  const invalidate = async (): Promise<void> => {
    await Promise.all(
      ['kanban', 'board', 'backlog', 'work-items'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };
  const move = useMutation({
    mutationFn: (body: MoveKanbanCardInput) => kanbanApi.move(body),
    onSuccess: () => {
      setError(null);
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('kanban.couldNotMoveTheCard'));
    },
    onSettled: invalidate,
  });
  const saveLimits = useMutation({
    mutationFn: (entries: Record<string, string>) =>
      kanbanApi.setWipLimits({
        projectId,
        limits: WIP_LIMITED_COLUMNS.map((column) => {
          const raw = (entries[column] ?? '').trim();
          return { column, wipLimit: raw === '' ? null : Number(raw) };
        }),
      }),
    onSuccess: async () => {
      setError(null);
      setLimits(null);
      setSaved(true);
      await invalidate();
    },
    onError: (cause) => {
      setSaved(false);
      setError(cause instanceof ApiError ? cause.message : t('kanban.couldNotSaveTheWip'));
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  const view = board.data;
  const editable = can('work_items.write');
  const manager = can('work_items.manage');

  const send = (card: KanbanCard, column: KanbanColumnId, placement: Placement): void => {
    move.mutate({ projectId, workItemId: card.id, column, version: card.version, ...placement });
  };
  const limitDraft =
    limits ??
    Object.fromEntries(
      (view?.columns ?? []).map((column) => [column.id, column.wipLimit?.toString() ?? '']),
    );

  return (
    <>
      <PageHeader title={t('kanban.kanban')} description={t('kanban.theFlowOfEveryWork')} />
      <section className="card filters" aria-label={t('kanban.kanbanFilters')}>
        <SelectField
          label={t('kanban.assignee')}
          value={assigneeId}
          options={[
            { value: '', label: t('kanban.anyone') },
            { value: 'me', label: t('kanban.me') },
            { value: 'none', label: t('kanban.unassigned') },
            ...uniqueAssignees(view).map((entry) => ({ value: entry.id, label: entry.fullName })),
          ]}
          onChange={(event) => {
            setAssigneeId(event.target.value);
          }}
        />
        <SelectField
          label={t('kanban.priority')}
          value={priority}
          options={[
            { value: '', label: t('kanban.anyPriority') },
            ...PRIORITIES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setPriority(event.target.value);
          }}
        />
        <SelectField
          label={t('kanban.type')}
          value={type}
          options={[
            { value: '', label: t('kanban.anyType') },
            ...WORK_ITEM_TYPES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setType(event.target.value);
          }}
        />
        <SelectField
          label={t('kanban.epic')}
          value={epicId}
          options={[
            { value: '', label: t('kanban.anyEpic') },
            { value: 'none', label: t('kanban.noEpic') },
            ...(view?.epics ?? []).map((ref) => ({
              value: ref.id,
              label: `${ref.key} ${ref.title}`,
            })),
          ]}
          onChange={(event) => {
            setEpicId(event.target.value);
          }}
        />
        <SelectField
          label={t('kanban.feature')}
          value={featureId}
          options={[
            { value: '', label: t('kanban.anyFeature') },
            { value: 'none', label: t('kanban.noFeature') },
            ...(view?.features ?? []).map((ref) => ({
              value: ref.id,
              label: `${ref.key} ${ref.title}`,
            })),
          ]}
          onChange={(event) => {
            setFeatureId(event.target.value);
          }}
        />
        <SelectField
          label={t('kanban.release')}
          value={releaseId}
          options={[
            { value: '', label: t('kanban.anyRelease') },
            { value: 'none', label: t('kanban.noRelease') },
            ...(releases.data?.data ?? []).map((row) => ({ value: row.id, label: row.name })),
          ]}
          onChange={(event) => {
            setReleaseId(event.target.value);
          }}
        />
        <TextField
          label={t('kanban.searchTheKanbanBoard')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <SelectField
          label={t('kanban.developmentFilter')}
          value={developmentStatus}
          options={DEVELOPMENT_STATUS_OPTIONS}
          onChange={(event) => {
            setDevelopmentStatus(event.target.value);
          }}
        />
        <SelectField
          label={t('kanban.swimlanes')}
          value={swimlane}
          options={BOARD_SWIMLANES.map((value) => ({
            value,
            label: value === 'none' ? t('kanban.noSwimlanes') : t('kanban.by', { value }),
          }))}
          onChange={(event) => {
            setSwimlane(event.target.value as BoardSwimlane);
          }}
        />
        <SelectField
          label={t('kanban.window')}
          value={String(windowDays)}
          options={[7, 14, 30, 90].map((value) => ({
            value: String(value),
            label: t('kanban.lastDays', { value }),
          }))}
          onChange={(event) => {
            setWindowDays(Number(event.target.value));
          }}
        />
      </section>

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <DataState isPending={board.isPending} error={board.error} isEmpty={false}>
        {view !== undefined && (
          <>
            <section className="card" aria-labelledby="kanban-flow">
              <h2 id="kanban-flow">
                {t('kanban.flowLast')} {view.windowDays} {t('kanban.days')}
              </h2>
              <dl className="kpis">
                <div>
                  <dt>{t('kanban.throughput')}</dt>
                  <dd data-testid="kanban-throughput">{view.metrics.throughput.total}</dd>
                </div>
                <div>
                  <dt>{t('kanban.cycleTimeAvg')}</dt>
                  <dd data-testid="kanban-cycle-time">
                    {formatDays(view.metrics.cycleTime.averageDays)}
                  </dd>
                </div>
                <div>
                  <dt>{t('kanban.cycleTime85')}</dt>
                  <dd>{formatDays(view.metrics.cycleTime.p85Days)}</dd>
                </div>
                <div>
                  <dt>{t('kanban.inProgress')}</dt>
                  <dd data-testid="kanban-wip">{view.metrics.aging.count}</dd>
                </div>
                <div>
                  <dt>{t('kanban.averageAge')}</dt>
                  <dd>{formatDays(view.metrics.aging.averageDays)}</dd>
                </div>
              </dl>
              <p className="muted" data-testid="kanban-shown">
                {view.shown} {t('kanban.of')} {view.total} {t('kanban.cardsShown')}
                {view.truncated ? t('kanban.boardTruncated') : ''}
              </p>
              {!editable && <p role="note">{t('kanban.readOnlyYouDoNot')}</p>}
            </section>

            {manager && (
              <form
                className="card wip-limits"
                aria-label={t('kanban.wipLimits')}
                onSubmit={(event) => {
                  event.preventDefault();
                  setSaved(false);
                  saveLimits.mutate(limitDraft);
                }}
              >
                {WIP_LIMITED_COLUMNS.map((column) => (
                  <TextField
                    key={column}
                    label={t('kanban.wipLimit', {
                      value: KANBAN_COLUMNS.find((entry) => entry.id === column)?.label ?? column,
                    })}
                    type="number"
                    min={1}
                    max={999}
                    value={limitDraft[column] ?? ''}
                    onChange={(event) => {
                      setSaved(false);
                      setLimits({ ...limitDraft, [column]: event.target.value });
                    }}
                  />
                ))}
                <Button type="submit" disabled={saveLimits.isPending}>
                  {t('kanban.saveWipLimits')}
                </Button>
                {saved && <p role="status">{t('kanban.wipLimitsSaved')}</p>}
              </form>
            )}

            {lanesOf(view).map((lane) => (
              <section
                key={lane.id ?? 'none'}
                className="board-lane"
                aria-label={
                  lane.title === ''
                    ? t('kanban.kanbanBoard')
                    : t('kanban.swimlane', { title: lane.title })
                }
              >
                {lane.title !== '' && <h2>{lane.title}</h2>}
                <div className="board board--kanban">
                  {view.columns.map((column) => {
                    const ids = column.cardIds.filter((id) => lane.cardIds.includes(id));
                    const cards = ids
                      .map((id) => view.cards.find((card) => card.id === id))
                      .filter((card): card is KanbanCard => card !== undefined);
                    const state = wipState(column.count, column.wipLimit);
                    const drop = (targetId: string | null): void => {
                      const card = view.cards.find((entry) => entry.id === dragged);
                      setDragged(null);
                      if (card !== undefined) {
                        send(card, column.id, dropPlacement(ids, card.id, targetId));
                      }
                    };
                    return (
                      <section
                        key={column.id}
                        className={`board-column${state === 'open' ? '' : ` board-column--${state}`}`}
                        aria-label={t('kanban.column', { label: column.label })}
                        data-testid={`kanban-column-${column.id}`}
                        onDragOver={(event) => {
                          if (editable) {
                            event.preventDefault();
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          drop(null);
                        }}
                      >
                        <h3>
                          {column.label}{' '}
                          <span className="muted" data-testid={`kanban-count-${column.id}`}>
                            ({columnCount(column)} · {column.estimate} {t('kanban.pts')}
                          </span>
                        </h3>
                        {state !== 'open' && (
                          <p className="muted">
                            {state === 'full'
                              ? t('kanban.wipLimitReached')
                              : t('kanban.overTheWipLimit')}
                          </p>
                        )}
                        <ul>
                          {cards.map((card, index) => (
                            <li
                              key={card.id}
                              data-testid={`kanban-card-${card.key}`}
                              className={[
                                'board-card',
                                card.status === 'blocked' ? 'board-card--blocked' : '',
                                dragged === card.id ? 'dragging' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              draggable={editable}
                              onDragStart={(event) => {
                                event.dataTransfer.setData('text/plain', card.id);
                                setDragged(card.id);
                              }}
                              onDragEnd={() => {
                                setDragged(null);
                              }}
                              onDrop={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                drop(card.id);
                              }}
                            >
                              <Link to={`/work-items/${card.id}`}>
                                {card.key} {card.title}
                              </Link>
                              <div className="board-card__meta">
                                <Badge tone="neutral">{humanize(card.type)}</Badge>
                                <DevelopmentStatusBadge status={card.developmentStatus} />
                                <Badge tone="info">{humanize(card.priority)}</Badge>
                                {card.status === 'blocked' && (
                                  <Badge tone={WORK_ITEM_TONE.blocked}>{t('kanban.blocked')}</Badge>
                                )}
                                <span>
                                  {card.estimate === null
                                    ? t('kanban.pts2')
                                    : t('kanban.pts3', { estimate: card.estimate })}
                                </span>
                                <span>{card.assignee?.fullName ?? t('kanban.unassigned')}</span>
                                <span title={card.requirements.keys.join(', ')}>
                                  {card.requirements.count === 0
                                    ? t('kanban.noRequirement')
                                    : t('kanban.requirementS', { count: card.requirements.count })}
                                </span>
                                <span data-testid={`kanban-time-${card.key}`}>
                                  {card.inStatusDays} {t('kanban.dIn')} {humanize(card.status)}
                                  {card.ageDays === null
                                    ? ''
                                    : t('kanban.ageD', { ageDays: card.ageDays })}
                                </span>
                              </div>
                              {editable && (
                                <div className="row-actions">
                                  <select
                                    aria-label={t('kanban.moveToColumn', { key: card.key })}
                                    value={column.id}
                                    onChange={(event) => {
                                      const target = event.target.value as KanbanColumnId;
                                      const targetIds =
                                        view.columns.find((entry) => entry.id === target)
                                          ?.cardIds ?? [];
                                      send(card, target, dropPlacement(targetIds, card.id, null));
                                    }}
                                  >
                                    {KANBAN_COLUMNS.map((entry) => (
                                      <option key={entry.id} value={entry.id}>
                                        {entry.label}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    aria-label={t('kanban.moveUp', { key: card.key })}
                                    disabled={index === 0 || move.isPending}
                                    onClick={() => {
                                      send(card, column.id, { beforeId: ids[index - 1] ?? '' });
                                    }}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={t('kanban.moveDown', { key: card.key })}
                                    disabled={index === ids.length - 1 || move.isPending}
                                    onClick={() => {
                                      send(card, column.id, { afterId: ids[index + 1] ?? '' });
                                    }}
                                  >
                                    ↓
                                  </button>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                </div>
              </section>
            ))}
          </>
        )}
      </DataState>
    </>
  );
}

function lanesOf(view: KanbanView): Array<{ id: string | null; title: string; cardIds: string[] }> {
  return view.swimlane === 'none'
    ? [{ id: null, title: '', cardIds: view.cards.map((card) => card.id) }]
    : view.swimlanes;
}

function uniqueAssignees(view: KanbanView | undefined): Array<{ id: string; fullName: string }> {
  const seen = new Map<string, string>();
  for (const card of view?.cards ?? []) {
    if (card.assignee !== null) {
      seen.set(card.assignee.id, card.assignee.fullName);
    }
  }
  return [...seen].map(([id, fullName]) => ({ id, fullName }));
}
