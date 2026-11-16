import { SPRINT_TRANSITIONS, WORK_ITEM_STATUSES, isOpenSprint } from '@qa-flow-hub/shared';
import type { SprintDetailView } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { backlogApi, sprintsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { SPRINT_TONE, formatPoints } from './SprintsPage';
import { t } from '../i18n/i18n';

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback;
}

export function SprintDetailPage(): React.JSX.Element {
  const { sprintId = '' } = useParams();
  const sprint = useQuery({
    queryKey: ['sprints', 'detail', sprintId],
    queryFn: () => sprintsApi.get(sprintId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  return (
    <DataState isPending={sprint.isPending} error={sprint.error} isEmpty={false}>
      {sprint.data !== undefined && <SprintDetail sprint={sprint.data} />}
    </DataState>
  );
}

function SprintDetail({ sprint }: { sprint: SprintDetailView }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(sprint.projectId);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [carryOverTo, setCarryOverTo] = useState('backlog');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const open = isOpenSprint(sprint.status);
  const manage = can('work_items.manage') && open;
  const plan = can('work_items.write') && open;
  const { metrics } = sprint;

  const planned = useQuery({
    queryKey: ['sprints', sprint.projectId, 'planned'],
    queryFn: () => sprintsApi.list({ projectId: sprint.projectId, status: 'planned' }),
    enabled: manage,
  });
  const backlog = useQuery({
    queryKey: ['backlog', sprint.projectId, 'sprint-candidates'],
    queryFn: () => backlogApi.get({ projectId: sprint.projectId, sprintId: 'none' }),
    enabled: plan,
    staleTime: 0,
  });

  const refresh = async (): Promise<void> => {
    setError(null);
    setSelected(new Set());
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['sprints'] }),
      queryClient.invalidateQueries({ queryKey: ['backlog'] }),
      queryClient.invalidateQueries({ queryKey: ['work-items'] }),
    ]);
  };

  const start = useMutation({
    mutationFn: () => sprintsApi.start(sprint.id),
    onSuccess: async () => {
      setNotice(t('sprintDetail.sprintStarted'));
      await refresh();
    },
    onError: (cause) => {
      setError(messageOf(cause, t('sprintDetail.couldNotStartTheSprint')));
    },
  });
  const close = useMutation({
    mutationFn: (action: 'complete' | 'cancel') =>
      sprintsApi.close(sprint.id, action, { carryOverTo }),
    onSuccess: async (result) => {
      setNotice(
        t('sprintDetail.sprintUnfinishedItemSCarried', {
          value: humanize(result.sprint.status).toLowerCase(),
          carriedOver: result.carriedOver,
        }),
      );
      await refresh();
    },
    onError: (cause) => {
      setError(messageOf(cause, t('sprintDetail.couldNotCloseTheSprint')));
    },
  });
  const add = useMutation({
    mutationFn: () => sprintsApi.addItems(sprint.id, [...selected]),
    onSuccess: refresh,
    onError: (cause) => {
      setError(messageOf(cause, t('sprintDetail.couldNotPlanTheItems')));
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => sprintsApi.removeItems(sprint.id, [id]),
    onSuccess: refresh,
    onError: (cause) => {
      setError(messageOf(cause, t('sprintDetail.couldNotMoveToBacklog')));
    },
  });

  const candidates = (backlog.data?.items ?? []).filter((item) => item.sprintId === null);

  return (
    <>
      <PageHeader title={sprint.name} description={sprint.goal ?? t('sprintDetail.noGoalSet')} />
      <p>
        <Badge tone={SPRINT_TONE[sprint.status]}>{humanize(sprint.status)}</Badge>{' '}
        <span>
          {sprint.startDate ?? '—'} → {sprint.endDate ?? '—'}
        </span>{' '}
        <Link to="/sprints">{t('sprintDetail.allSprints')}</Link>
      </p>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {notice !== null && <p role="status">{notice}</p>}

      {manage && (
        <section className="card actions" aria-label={t('sprintDetail.sprintActions')}>
          {SPRINT_TRANSITIONS[sprint.status].includes('active') && (
            <Button
              loading={start.isPending}
              onClick={() => {
                start.mutate();
              }}
            >
              {t('sprintDetail.startSprint')}
            </Button>
          )}
          <SelectField
            label={t('sprintDetail.carryUnfinishedItemsTo')}
            value={carryOverTo}
            options={[
              { value: 'backlog', label: t('sprintDetail.backlog') },
              ...(planned.data?.data ?? [])
                .filter((row) => row.id !== sprint.id)
                .map((row) => ({ value: row.id, label: row.name })),
            ]}
            onChange={(event) => {
              setCarryOverTo(event.target.value);
            }}
          />
          {SPRINT_TRANSITIONS[sprint.status].includes('completed') && (
            <Button
              loading={close.isPending && close.variables === 'complete'}
              onClick={() => {
                close.mutate('complete');
              }}
            >
              {t('sprintDetail.completeSprint')}
            </Button>
          )}
          <Button
            variant="secondary"
            loading={close.isPending && close.variables === 'cancel'}
            onClick={() => {
              close.mutate('cancel');
            }}
          >
            {t('sprintDetail.cancelSprint')}
          </Button>
        </section>
      )}

      <section className="card" aria-labelledby="sprint-metrics">
        <h2 id="sprint-metrics">{t('sprintDetail.metrics')}</h2>
        <dl className="kpis">
          <div>
            <dt>{t('sprintDetail.capacity')}</dt>
            <dd>{formatPoints(metrics.capacity)}</dd>
          </div>
          <div>
            <dt>{t('sprintDetail.committed')}</dt>
            <dd data-testid="committed">{metrics.committedEstimate}</dd>
          </div>
          <div>
            <dt>{t('sprintDetail.scope')}</dt>
            <dd>{metrics.scopeEstimate}</dd>
          </div>
          <div>
            <dt>{t('sprintDetail.completed')}</dt>
            <dd data-testid="completed">{metrics.completedEstimate}</dd>
          </div>
          <div>
            <dt>{t('sprintDetail.load')}</dt>
            <dd>{metrics.load === null ? '—' : `${metrics.load}%`}</dd>
          </div>
          <div>
            <dt>{t('sprintDetail.progress')}</dt>
            <dd data-testid="progress">
              {metrics.progress === null ? '—' : `${metrics.progress}%`}
            </dd>
          </div>
        </dl>
        <ul className="inline-list" aria-label={t('sprintDetail.progressByStatus')}>
          {WORK_ITEM_STATUSES.filter((status) => metrics.byStatus[status] > 0).map((status) => (
            <li key={status}>
              <Badge tone={toneFor(status)}>
                {humanize(status)}: {metrics.byStatus[status]}
              </Badge>
            </li>
          ))}
        </ul>
      </section>

      {can('work_items.manage') && open && <SprintEditor sprint={sprint} onSaved={refresh} />}

      <section className="card" aria-labelledby="sprint-backlog">
        <h2 id="sprint-backlog">{t('sprintDetail.sprintBacklog')}</h2>
        {sprint.items.length === 0 ? (
          <p>{t('sprintDetail.noWorkItemInThis')}</p>
        ) : (
          <table className="table" aria-label={t('sprintDetail.sprintBacklog')}>
            <thead>
              <tr>
                <th scope="col">{t('sprintDetail.key')}</th>
                <th scope="col">{t('sprintDetail.title')}</th>
                <th scope="col">{t('sprintDetail.status')}</th>
                <th scope="col">{t('sprintDetail.estimate')}</th>
                {plan && <th scope="col">{t('sprintDetail.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {sprint.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link to={`/work-items/${item.id}`}>{item.key}</Link>
                  </td>
                  <td>{item.title}</td>
                  <td>
                    <Badge tone={toneFor(item.status)}>{humanize(item.status)}</Badge>
                  </td>
                  <td>{formatPoints(item.estimate)}</td>
                  {plan && (
                    <td>
                      <Button
                        variant="secondary"
                        aria-label={t('sprintDetail.moveToTheBacklog', { key: item.key })}
                        loading={remove.isPending && remove.variables === item.id}
                        onClick={() => {
                          remove.mutate(item.id);
                        }}
                      >
                        {t('sprintDetail.toBacklog')}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {plan && (
        <section className="card" aria-labelledby="sprint-candidates">
          <h2 id="sprint-candidates">{t('sprintDetail.planFromTheBacklog')}</h2>
          {candidates.length === 0 ? (
            <p>{t('sprintDetail.everyOpenItemIsAlready')}</p>
          ) : (
            <>
              <ul className="plain-list">
                {candidates.map((item) => (
                  <li key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={t('sprintDetail.plan', { key: item.key })}
                        checked={selected.has(item.id)}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.target.checked) {
                            next.add(item.id);
                          } else {
                            next.delete(item.id);
                          }
                          setSelected(next);
                        }}
                      />{' '}
                      {item.key} · {item.title} ({formatPoints(item.estimate)})
                    </label>
                  </li>
                ))}
              </ul>
              <Button
                loading={add.isPending}
                disabled={selected.size === 0}
                onClick={() => {
                  add.mutate();
                }}
              >
                {t('sprintDetail.addToSprint')}
              </Button>
            </>
          )}
        </section>
      )}
    </>
  );
}

function SprintEditor({
  sprint,
  onSaved,
}: {
  sprint: SprintDetailView;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal ?? '');
  const [startDate, setStartDate] = useState(sprint.startDate ?? '');
  const [endDate, setEndDate] = useState(sprint.endDate ?? '');
  const [capacity, setCapacity] = useState(sprint.capacity === null ? '' : String(sprint.capacity));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      sprintsApi.update(sprint.id, {
        name: name.trim(),
        goal: goal.trim() === '' ? null : goal.trim(),
        startDate: startDate === '' ? null : startDate,
        endDate: endDate === '' ? null : endDate,
        capacity: capacity.trim() === '' ? null : Number(capacity),
        version: sprint.version,
      }),
    onSuccess: async () => {
      setError(null);
      await onSaved();
    },
    onError: (cause) => {
      setError(messageOf(cause, t('sprintDetail.couldNotSaveTheSprint')));
    },
  });
  return (
    <section className="card" aria-labelledby="edit-sprint">
      <h2 id="edit-sprint">{t('sprintDetail.editSprint')}</h2>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      <TextField
        label={t('sprintDetail.name')}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <TextField
        label={t('sprintDetail.sprintGoal')}
        value={goal}
        onChange={(event) => {
          setGoal(event.target.value);
        }}
      />
      <TextField
        label={t('sprintDetail.starts')}
        type="date"
        value={startDate}
        onChange={(event) => {
          setStartDate(event.target.value);
        }}
      />
      <TextField
        label={t('sprintDetail.ends')}
        type="date"
        value={endDate}
        onChange={(event) => {
          setEndDate(event.target.value);
        }}
      />
      <TextField
        label={t('sprintDetail.capacity')}
        type="number"
        min={0}
        value={capacity}
        onChange={(event) => {
          setCapacity(event.target.value);
        }}
      />
      <Button
        loading={save.isPending}
        disabled={name.trim() === ''}
        onClick={() => {
          save.mutate();
        }}
      >
        {t('sprintDetail.saveSprint')}
      </Button>
    </section>
  );
}
