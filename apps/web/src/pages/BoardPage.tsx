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
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { SPRINT_TONE, formatPoints } from './SprintsPage';
import { WORK_ITEM_TONE } from './WorkItemsPage';

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
      setError(cause instanceof ApiError ? cause.message : 'Could not move the card.');
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
      <PageHeader
        title="Board"
        description="The Scrum board of the active sprint. Drag cards between columns, or use the controls on each card."
      />
      <section className="card filters" aria-label="Board filters">
        <SelectField
          label="Sprint"
          value={sprintId}
          options={[
            { value: '', label: 'Active sprint' },
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
          label="Assignee"
          value={assigneeId}
          options={[
            { value: '', label: 'Anyone' },
            { value: 'me', label: 'Me' },
            { value: 'none', label: 'Unassigned' },
            ...uniqueAssignees(view).map((entry) => ({ value: entry.id, label: entry.fullName })),
          ]}
          onChange={(event) => {
            setAssigneeId(event.target.value);
          }}
        />
        <SelectField
          label="Priority"
          value={priority}
          options={[
            { value: '', label: 'Any priority' },
            ...PRIORITIES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setPriority(event.target.value);
          }}
        />
        <SelectField
          label="Type"
          value={type}
          options={[
            { value: '', label: 'Any type' },
            ...WORK_ITEM_TYPES.map((value) => ({ value, label: humanize(value) })),
          ]}
          onChange={(event) => {
            setType(event.target.value);
          }}
        />
        <SelectField
          label="Epic"
          value={epicId}
          options={[
            { value: '', label: 'Any epic' },
            { value: 'none', label: 'No epic' },
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
          label="Feature"
          value={featureId}
          options={[
            { value: '', label: 'Any feature' },
            { value: 'none', label: 'No feature' },
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
          label="Search the board"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <SelectField
          label="Swimlanes"
          value={swimlane}
          options={BOARD_SWIMLANES.map((value) => ({
            value,
            label: value === 'none' ? 'No swimlanes' : `By ${value}`,
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
            No active sprint in this project. <Link to="/sprints">Plan and start a sprint</Link>.
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
                  <dt>Capacity</dt>
                  <dd>{formatPoints(view.metrics.capacity)}</dd>
                </div>
                <div>
                  <dt>Committed</dt>
                  <dd data-testid="board-committed">{view.metrics.committedEstimate}</dd>
                </div>
                <div>
                  <dt>Completed</dt>
                  <dd data-testid="board-completed">{view.metrics.completedEstimate}</dd>
                </div>
                <div>
                  <dt>Progress</dt>
                  <dd data-testid="board-progress">
                    {view.metrics.progress === null ? '—' : `${view.metrics.progress}%`}
                  </dd>
                </div>
                <div>
                  <dt>Velocity</dt>
                  <dd>{formatPoints(view.velocity.velocity)}</dd>
                </div>
              </dl>
              <p className="muted" data-testid="board-shown">
                {view.shown} of {view.total} cards shown
                {view.truncated ? ' (board truncated)' : ''}
              </p>
              {!writable && <p role="note">Read-only: you do not have permission to move cards.</p>}
              {writable && sprint.status !== 'active' && (
                <p role="note">This sprint is {humanize(sprint.status)}; its board is read-only.</p>
              )}
            </section>
            {lanesOf(view).map((lane) => (
              <section
                key={lane.id ?? 'none'}
                className="board-lane"
                aria-label={lane.title === '' ? 'Board' : `Swimlane ${lane.title}`}
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
                        aria-label={`${column.label} column`}
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
                            ({cards.length} · {column.estimate} pts)
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
                                <Badge tone="info">{humanize(card.priority)}</Badge>
                                {card.status === 'blocked' && (
                                  <Badge tone={WORK_ITEM_TONE.blocked}>Blocked</Badge>
                                )}
                                <span>
                                  {card.estimate === null ? '— pts' : `${card.estimate} pts`}
                                </span>
                                <span>{card.assignee?.fullName ?? 'Unassigned'}</span>
                                <span title={card.requirements.keys.join(', ')}>
                                  {card.requirements.count === 0
                                    ? 'No requirement'
                                    : `${card.requirements.count} requirement(s)`}
                                </span>
                              </div>
                              {editable && (
                                <div className="row-actions">
                                  <select
                                    aria-label={`Move ${card.key} to column`}
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
                                    aria-label={`Move ${card.key} up`}
                                    disabled={index === 0 || move.isPending}
                                    onClick={() => {
                                      send(card, column.id, { beforeId: ids[index - 1] ?? '' });
                                    }}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Move ${card.key} down`}
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
