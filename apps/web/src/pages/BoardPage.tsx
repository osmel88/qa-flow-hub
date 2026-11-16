import type { DevelopmentStatus } from '@qa-flow-hub/shared';
import { BOARD_COLUMNS, BOARD_SWIMLANES, PRIORITIES, WORK_ITEM_TYPES } from '@qa-flow-hub/shared';
import type {
  BoardCard,
  BoardColumnId,
  BoardQuery,
  BoardSwimlane,
  BoardView,
  MoveBoardCardInput,
} from '@qa-flow-hub/shared';
import { Badge, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { sprintsApi } from '../api/endpoints';
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
import { SPRINT_TONE, formatPoints } from './SprintsPage';
import { WORK_ITEM_TONE } from './WorkItemsPage';
import { t } from '../i18n/i18n';

type Placement = Pick<MoveBoardCardInput, 'beforeId' | 'afterId'>;

/** Where a dropped card lands among the cards of the target column. */
export function dropPlacement(
  columnIds: readonly string[],
  draggedId: string,
  targetId: string | null,
): Placement {
  const others = columnIds.filter((id) => id !== draggedId);
  if (targetId === null || targetId === draggedId) {
    const last = others.at(-1);
    return last === undefined ? {} : { afterId: last };
  }
  const from = columnIds.indexOf(draggedId);
  const to = columnIds.indexOf(targetId);
  return from !== -1 && from < to ? { afterId: targetId } : { beforeId: targetId };
}

export function BoardPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(activeProjectId);
  const [sprintId, setSprintId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState('');
  const [type, setType] = useState('');
  const [epicId, setEpicId] = useState('');
  const [featureId, setFeatureId] = useState('');
  const [search, setSearch] = useState('');
  const [developmentStatus, setDevelopmentStatus] = useState('');
  const [swimlane, setSwimlane] = useState<BoardSwimlane>('none');
  const [dragged, setDragged] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectId = activeProjectId ?? '';
  const trimmed = search.trim();

  const params = {
    projectId,
    swimlane,
    ...(sprintId === '' ? {} : { sprintId }),
    ...(assigneeId === '' ? {} : { assigneeId }),
    ...(priority === '' ? {} : { priority: priority as NonNullable<BoardQuery['priority']> }),
    ...(type === '' ? {} : { type: type as NonNullable<BoardQuery['type']> }),
    ...(epicId === '' ? {} : { epicId }),
    ...(featureId === '' ? {} : { featureId }),
    ...(trimmed === '' ? {} : { search: trimmed }),
    ...(developmentStatus === ''
      ? {}
      : { developmentStatus: developmentStatus as DevelopmentStatus }),
  };
  const board = useQuery({
    queryKey: ['board', params],
    queryFn: () => sprintsApi.board(params),
    enabled: activeProjectId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const sprints = useQuery({
    queryKey: ['sprints', activeProjectId, 'all'],
    queryFn: () => sprintsApi.list({ projectId }),
    enabled: activeProjectId !== null,
  });

  const move = useMutation({
    mutationFn: ({ id, body }: { id: string; body: MoveBoardCardInput }) =>
      sprintsApi.moveCard(id, body),
    onSuccess: () => {
      setError(null);
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('board.couldNotMoveTheCard'));
    },
    onSettled: async () => {
      await Promise.all(
        ['board', 'sprints', 'backlog', 'work-items'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  const view = board.data;
  const sprint = view?.sprint ?? null;
  const writable = can('work_items.write');
  const editable = writable && sprint?.status === 'active';

  const send = (card: BoardCard, column: BoardColumnId, placement: Placement): void => {
    if (sprint === null) {
      return;
    }
    move.mutate({
      id: sprint.id,
      body: { workItemId: card.id, column, version: card.version, ...placement },
    });
  };

  return (
    <>
      <PageHeader title={t('board.board')} description={t('board.theScrumBoardOfThe')} />
      <section className="card filters" aria-label={t('board.boardFilters')}>
        <SelectField
          label={t('board.sprint')}
          value={sprintId}
          options={[
            { value: '', label: t('board.activeSprint') },
            ...(sprints.data?.data ?? []).map((row) => ({
              value: row.id,
              label: `${row.name} (${humanize(row.status)})`,
            })),
          ]}
          onChange={(event) => {
            setSprintId(event.target.value);
          }}
        />
        <SelectField
          label={t('board.assignee')}
          value={assigneeId}
          options={[
            { value: '', label: t('board.anyone') },
            { value: 'me', label: t('board.me') },
            { value: 'none', label: t('board.unassigned') },
            ...uniqueAssignees(view).map((entry) => ({ value: entry.id, label: entry.fullName })),
          ]}
          onChange={(event) => {
            setAssigneeId(event.target.value);
          }}
        />
        <SelectField
          label={t('board.priority')}
          value={priority}
          options={[
            { value: '', label: t('board.anyPriority') },
            ...PRIORITIES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setPriority(event.target.value);
          }}
        />
        <SelectField
          label={t('board.type')}
          value={type}
          options={[
            { value: '', label: t('board.anyType') },
            ...WORK_ITEM_TYPES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setType(event.target.value);
          }}
        />
        <SelectField
          label={t('board.epic')}
          value={epicId}
          options={[
            { value: '', label: t('board.anyEpic') },
            { value: 'none', label: t('board.noEpic') },
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
          label={t('board.feature')}
          value={featureId}
          options={[
            { value: '', label: t('board.anyFeature') },
            { value: 'none', label: t('board.noFeature') },
            ...(view?.features ?? []).map((ref) => ({
              value: ref.id,
              label: `${ref.key} ${ref.title}`,
            })),
          ]}
          onChange={(event) => {
            setFeatureId(event.target.value);
          }}
        />
        <TextField
          label={t('board.searchTheBoard')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <SelectField
          label={t('board.developmentFilter')}
          value={developmentStatus}
          options={DEVELOPMENT_STATUS_OPTIONS}
          onChange={(event) => {
            setDevelopmentStatus(event.target.value);
          }}
        />
        <SelectField
          label={t('board.swimlanes')}
          value={swimlane}
          options={BOARD_SWIMLANES.map((value) => ({
            value,
            label: value === 'none' ? t('board.noSwimlanes') : t('board.by', { value }),
          }))}
          onChange={(event) => {
            setSwimlane(event.target.value as BoardSwimlane);
          }}
        />
      </section>

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <DataState isPending={board.isPending} error={board.error} isEmpty={false}>
        {view !== undefined && sprint === null && (
          <p className="card">
            {t('board.noActiveSprintInThis')}{' '}
            <Link to="/sprints">{t('board.planAndStartASprint')}</Link>.
          </p>
        )}
        {view !== undefined && sprint !== null && view.metrics !== null && (
          <>
            <section className="card" aria-labelledby="board-sprint">
              <h2 id="board-sprint">
                <Link to={`/sprints/${sprint.id}`}>{sprint.name}</Link>{' '}
                <Badge tone={SPRINT_TONE[sprint.status]}>{humanize(sprint.status)}</Badge>
              </h2>
              <dl className="kpis">
                <div>
                  <dt>{t('board.capacity')}</dt>
                  <dd>{formatPoints(view.metrics.capacity)}</dd>
                </div>
                <div>
                  <dt>{t('board.committed')}</dt>
                  <dd data-testid="board-committed">{view.metrics.committedEstimate}</dd>
                </div>
                <div>
                  <dt>{t('board.completed')}</dt>
                  <dd data-testid="board-completed">{view.metrics.completedEstimate}</dd>
                </div>
                <div>
                  <dt>{t('board.progress')}</dt>
                  <dd data-testid="board-progress">
                    {view.metrics.progress === null ? '—' : `${view.metrics.progress}%`}
                  </dd>
                </div>
                <div>
                  <dt>{t('board.velocity')}</dt>
                  <dd>{formatPoints(view.velocity.velocity)}</dd>
                </div>
              </dl>
              <p className="muted" data-testid="board-shown">
                {view.shown} {t('board.of')} {view.total} {t('board.cardsShown')}
                {view.truncated ? t('board.boardTruncated') : ''}
              </p>
              {!writable && <p role="note">{t('board.readOnlyYouDoNot')}</p>}
              {writable && sprint.status !== 'active' && (
                <p role="note">
                  {t('board.thisSprintIs')} {humanize(sprint.status)}
                  {t('board.itsBoardIsReadOnly')}
                </p>
              )}
            </section>
            {lanesOf(view).map((lane) => (
              <section
                key={lane.id ?? 'none'}
                className="board-lane"
                aria-label={
                  lane.title === '' ? t('board.board') : t('board.swimlane', { title: lane.title })
                }
              >
                {lane.title !== '' && <h2>{lane.title}</h2>}
                <div className="board">
                  {view.columns.map((column) => {
                    const ids = column.cardIds.filter((id) => lane.cardIds.includes(id));
                    const cards = ids
                      .map((id) => view.cards.find((card) => card.id === id))
                      .filter((card): card is BoardCard => card !== undefined);
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
                        className="board-column"
                        aria-label={t('board.column', { label: column.label })}
                        data-testid={`board-column-${column.id}`}
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
                          <span className="muted">
                            ({cards.length} · {column.estimate} {t('board.pts')}
                          </span>
                        </h3>
                        <ul>
                          {cards.map((card, index) => (
                            <li
                              key={card.id}
                              data-testid={`board-card-${card.key}`}
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
                                  <Badge tone={WORK_ITEM_TONE.blocked}>{t('board.blocked')}</Badge>
                                )}
                                <span>
                                  {card.estimate === null
                                    ? t('board.pts2')
                                    : t('board.pts3', { estimate: card.estimate })}
                                </span>
                                <span>{card.assignee?.fullName ?? t('board.unassigned')}</span>
                                <span title={card.requirements.keys.join(', ')}>
                                  {card.requirements.count === 0
                                    ? t('board.noRequirement')
                                    : t('board.requirementS', { count: card.requirements.count })}
                                </span>
                              </div>
                              {editable && (
                                <div className="row-actions">
                                  <select
                                    aria-label={t('board.moveToColumn', { key: card.key })}
                                    value={column.id}
                                    onChange={(event) => {
                                      const target = event.target.value as BoardColumnId;
                                      const targetIds =
                                        view.columns.find((entry) => entry.id === target)
                                          ?.cardIds ?? [];
                                      send(card, target, dropPlacement(targetIds, card.id, null));
                                    }}
                                  >
                                    {BOARD_COLUMNS.map((entry) => (
                                      <option key={entry.id} value={entry.id}>
                                        {entry.label}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    aria-label={t('board.moveUp', { key: card.key })}
                                    disabled={index === 0 || move.isPending}
                                    onClick={() => {
                                      send(card, column.id, { beforeId: ids[index - 1] ?? '' });
                                    }}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={t('board.moveDown', { key: card.key })}
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

function lanesOf(view: BoardView): Array<{ id: string | null; title: string; cardIds: string[] }> {
  return view.swimlane === 'none'
    ? [{ id: null, title: '', cardIds: view.cards.map((card) => card.id) }]
    : view.swimlanes;
}

function uniqueAssignees(view: BoardView | undefined): Array<{ id: string; fullName: string }> {
  const seen = new Map<string, string>();
  for (const card of view?.cards ?? []) {
    if (card.assignee !== null) {
      seen.set(card.assignee.id, card.assignee.fullName);
    }
  }
  return [...seen].map(([id, fullName]) => ({ id, fullName }));
}
