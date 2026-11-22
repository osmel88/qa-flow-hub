import { DEFECT_SEVERITIES, EXPLORATORY_TRANSITIONS, FINDING_KINDS } from '@qa-flow-hub/shared';
import type { ExploratoryAction, ExploratoryStatus } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { defectsApi, exploratoryApi, workItemsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { EXPLORATORY_TONE, formatDuration } from './ExploratorySessionsPage';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';

const ACTIONS: Array<{ action: ExploratoryAction; label: string; from: ExploratoryStatus[] }> = [
  {
    action: 'start',
    get label() {
      return t('exploratorySessionDetail.startSession');
    },
    from: ['planned'],
  },
  {
    action: 'pause',
    get label() {
      return t('exploratorySessionDetail.pauseSession');
    },
    from: ['active'],
  },
  {
    action: 'resume',
    get label() {
      return t('exploratorySessionDetail.resumeSession');
    },
    from: ['paused'],
  },
  {
    action: 'complete',
    get label() {
      return t('exploratorySessionDetail.completeSession');
    },
    from: ['active', 'paused'],
  },
  {
    action: 'cancel',
    get label() {
      return t('exploratorySessionDetail.cancelSession');
    },
    from: ['planned', 'active', 'paused'],
  },
  {
    action: 'archive',
    get label() {
      return t('exploratorySessionDetail.archiveSession');
    },
    from: ['planned', 'completed', 'cancelled'],
  },
];

/** One exploratory session (S7-F5): run it, record findings, review it. */
export function ExploratorySessionDetailPage(): React.JSX.Element {
  const { sessionId = '' } = useParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [risks, setRisks] = useState('');
  const [note, setNote] = useState('');
  const [findingTitle, setFindingTitle] = useState('');
  const [findingDescription, setFindingDescription] = useState('');
  const [kind, setKind] = useState<string>('bug');
  const [severity, setSeverity] = useState<string>('major');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [existingDefect, setExistingDefect] = useState('');
  const [workItemId, setWorkItemId] = useState('');
  const session = useQuery({
    queryKey: ['exploratory-session', sessionId],
    queryFn: () => exploratoryApi.get(sessionId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const data = session.data;
  const projectId = data?.projectId ?? null;
  const { can } = useProjectPermissions(projectId);
  const defects = useQuery({
    queryKey: ['defects', projectId, 'exploratory'],
    queryFn: () => defectsApi.list({ projectId: projectId ?? '' }),
    enabled: projectId !== null,
  });
  const workItems = useQuery({
    queryKey: ['work-items', projectId, 'exploratory'],
    queryFn: () => workItemsApi.list({ projectId: projectId ?? '' }),
    enabled: projectId !== null,
  });
  useEffect(() => {
    if (data !== undefined) {
      setNotes(data.notes ?? '');
      setRisks(data.risks ?? '');
    }
  }, [data]);
  const mutate = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['exploratory-session', sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['exploratory-sessions'] });
    },
    onError: async (cause: unknown) => {
      setError(
        cause instanceof ApiError
          ? cause.message
          : t('exploratorySessionDetail.couldNotUpdateTheSession'),
      );
      await queryClient.invalidateQueries({ queryKey: ['exploratory-session', sessionId] });
    },
  });
  const open =
    data !== undefined &&
    EXPLORATORY_TRANSITIONS[data.status].length > 0 &&
    (data.status === 'planned' || data.status === 'active' || data.status === 'paused');
  const recording = data !== undefined && (data.status === 'active' || data.status === 'paused');
  const canRun = can('testruns.execute');
  return (
    <DataState isPending={session.isPending} error={session.error} isEmpty={false}>
      {data !== undefined && (
        <>
          <PageHeader
            title={t('exploratorySessionDetail.session', { title: data.title })}
            description={data.charter}
          />
          <p>
            <Link to="/exploratory-sessions">
              {t('exploratorySessionDetail.exploratoryTesting')}
            </Link>
          </p>
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <section className="card" aria-labelledby="session-summary">
            <h2 id="session-summary">{t('exploratorySessionDetail.summary')}</h2>
            <p>
              <Badge tone={EXPLORATORY_TONE[data.status]}>
                <span data-testid="session-status">{data.status}</span>
              </Badge>{' '}
              {t('exploratorySessionDetail.owner')}{' '}
              {data.owner?.fullName ?? t('exploratorySessionDetail.nobody')}{' '}
              {t('exploratorySessionDetail.environment')}{' '}
              {data.environment?.name ?? t('exploratorySessionDetail.none')}{' '}
              {t('exploratorySessionDetail.release')}{' '}
              {data.release === null ? t('exploratorySessionDetail.none') : data.release.version}
              {data.testPlan !== null && (
                <>
                  {' '}
                  {t('exploratorySessionDetail.plan')}{' '}
                  <Link to={`/test-plans/${data.testPlan.id}`}>{data.testPlan.name}</Link>
                </>
              )}
              {data.testCycle !== null && (
                <>
                  {' '}
                  {t('exploratorySessionDetail.cycle')}{' '}
                  <Link to={`/test-cycles/${data.testCycle.id}`}>{data.testCycle.name}</Link>
                </>
              )}
            </p>
            <p data-testid="session-metrics">
              {t('exploratorySessionDetail.duration')}{' '}
              {formatDuration(data.metrics.durationSeconds)}
              {data.metrics.timeboxMinutes !== null && ` of ${data.metrics.timeboxMinutes}m`} ·{' '}
              {data.metrics.findings} {t('exploratorySessionDetail.findings')}{' '}
              {data.metrics.defectsCreated} {t('exploratorySessionDetail.defectsCreated')}{' '}
              {data.metrics.defectsLinked} {t('exploratorySessionDetail.defectsRelated')}{' '}
              {data.metrics.notes} {t('exploratorySessionDetail.notes')}
            </p>
            <p className="muted">
              {t('exploratorySessionDetail.severity')}{' '}
              {Object.entries(data.metrics.bySeverity)
                .filter(([, count]) => count > 0)
                .map(([name, count]) => `${name} ${count}`)
                .join(', ') || t('exploratorySessionDetail.noFindings')}
            </p>
            <div className="row-actions">
              {ACTIONS.filter(
                (entry) =>
                  entry.from.includes(data.status) &&
                  can(
                    entry.action === 'cancel' || entry.action === 'archive'
                      ? 'testruns.manage'
                      : 'testruns.execute',
                  ),
              ).map((entry) => (
                <Button
                  key={entry.action}
                  variant={
                    entry.action === 'cancel' || entry.action === 'archive'
                      ? 'secondary'
                      : 'primary'
                  }
                  onClick={() => {
                    mutate.mutate(() => exploratoryApi.action(data.id, entry.action, data.version));
                  }}
                >
                  {entry.label}
                </Button>
              ))}
            </div>
          </section>

          <section className="card" aria-labelledby="session-notes">
            <h2 id="session-notes">{t('exploratorySessionDetail.notesAndRisks')}</h2>
            {open && canRun ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  mutate.mutate(() =>
                    exploratoryApi.update(data.id, {
                      notes: notes.trim() === '' ? null : notes,
                      risks: risks.trim() === '' ? null : risks,
                      version: data.version,
                    }),
                  );
                }}
              >
                <TextAreaField
                  label={t('exploratorySessionDetail.sessionNotes')}
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                  }}
                />
                <TextAreaField
                  label={t('exploratorySessionDetail.risks')}
                  value={risks}
                  onChange={(event) => {
                    setRisks(event.target.value);
                  }}
                />
                <Button type="submit">{t('exploratorySessionDetail.saveSession')}</Button>
              </form>
            ) : (
              <>
                <p>{data.notes ?? t('exploratorySessionDetail.noNotes')}</p>
                <p className="muted">
                  {t('exploratorySessionDetail.risks2')}{' '}
                  {data.risks ?? t('exploratorySessionDetail.none')}
                </p>
              </>
            )}
            <h3>{t('exploratorySessionDetail.attachmentsAndLinks')}</h3>
            <ul className="plain-list" aria-label={t('exploratorySessionDetail.sessionLinks')}>
              {data.links.map((link) => (
                <li key={`${link.label}-${link.url}`}>
                  {link.kind === 'attachment'
                    ? t('exploratorySessionDetail.attachment')
                    : t('exploratorySessionDetail.link')}
                  :{' '}
                  <a href={link.url} rel="noreferrer noopener" target="_blank">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
            {open && canRun && (
              <div className="row-actions">
                <TextField
                  label={t('exploratorySessionDetail.linkLabel')}
                  value={linkLabel}
                  onChange={(event) => {
                    setLinkLabel(event.target.value);
                  }}
                />
                <TextField
                  label={t('exploratorySessionDetail.linkUrl')}
                  value={linkUrl}
                  onChange={(event) => {
                    setLinkUrl(event.target.value);
                  }}
                />
                <Button
                  variant="secondary"
                  disabled={linkLabel.trim() === '' || linkUrl.trim() === ''}
                  onClick={() => {
                    mutate.mutate(async () => {
                      await exploratoryApi.update(data.id, {
                        links: [
                          ...data.links,
                          { label: linkLabel.trim(), url: linkUrl.trim(), kind: 'link' },
                        ],
                        version: data.version,
                      });
                      setLinkLabel('');
                      setLinkUrl('');
                    });
                  }}
                >
                  {t('exploratorySessionDetail.addLink')}
                </Button>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="session-findings">
            <h2 id="session-findings">{t('exploratorySessionDetail.findings2')}</h2>
            {recording && canRun && (
              <form
                aria-label={t('exploratorySessionDetail.newFinding')}
                onSubmit={(event) => {
                  event.preventDefault();
                  mutate.mutate(async () => {
                    await exploratoryApi.finding(data.id, {
                      title: findingTitle.trim(),
                      ...(findingDescription.trim() === ''
                        ? {}
                        : { description: findingDescription.trim() }),
                      kind: kind as (typeof FINDING_KINDS)[number],
                      severity: severity as (typeof DEFECT_SEVERITIES)[number],
                    });
                    setFindingTitle('');
                    setFindingDescription('');
                  });
                }}
              >
                <TextField
                  label={t('exploratorySessionDetail.findingTitle')}
                  value={findingTitle}
                  onChange={(event) => {
                    setFindingTitle(event.target.value);
                  }}
                />
                <TextAreaField
                  label={t('exploratorySessionDetail.findingDescription')}
                  value={findingDescription}
                  onChange={(event) => {
                    setFindingDescription(event.target.value);
                  }}
                />
                <SelectField
                  label={t('exploratorySessionDetail.findingKind')}
                  value={kind}
                  options={FINDING_KINDS.map((entry) => ({ value: entry, label: humanize(entry) }))}
                  onChange={(event) => {
                    setKind(event.target.value);
                  }}
                />
                <SelectField
                  label={t('exploratorySessionDetail.findingSeverity')}
                  value={severity}
                  options={DEFECT_SEVERITIES.map((entry) => ({
                    value: entry,
                    label: humanize(entry),
                  }))}
                  onChange={(event) => {
                    setSeverity(event.target.value);
                  }}
                />
                <Button type="submit" disabled={findingTitle.trim().length < 3}>
                  {t('exploratorySessionDetail.recordFinding')}
                </Button>
              </form>
            )}
            {data.findings.length === 0 ? (
              <p className="muted">{t('exploratorySessionDetail.noFindingYet')}</p>
            ) : (
              <ul className="plain-list" aria-label={t('exploratorySessionDetail.findings2')}>
                {data.findings.map((finding) => (
                  <li key={finding.id} data-testid={`finding-${finding.title}`}>
                    <strong>{finding.title}</strong> · {humanize(finding.kind)} · {finding.severity}
                    {finding.description !== null && (
                      <div className="muted">{finding.description}</div>
                    )}
                    {finding.defect !== null ? (
                      <div>
                        {finding.defectCreated
                          ? t('exploratorySessionDetail.defectCreated')
                          : t('exploratorySessionDetail.relatedDefect')}
                        : <Link to="/defects">{finding.defect.key}</Link> {finding.defect.title}
                      </div>
                    ) : (
                      recording && (
                        <div className="row-actions">
                          {can('defects.create') && (
                            <Button
                              size="sm"
                              onClick={() => {
                                mutate.mutate(() => exploratoryApi.convert(data.id, finding.id));
                              }}
                            >
                              {t('exploratorySessionDetail.createDefectFrom')} {finding.title}
                            </Button>
                          )}
                          {canRun && (
                            <>
                              <SelectField
                                label={t('exploratorySessionDetail.existingDefectFor', {
                                  title: finding.title,
                                })}
                                value={existingDefect}
                                options={[
                                  { value: '', label: t('exploratorySessionDetail.chooseADefect') },
                                  ...(defects.data?.data ?? []).map((entry) => ({
                                    value: entry.id,
                                    label: `${entry.key} ${entry.title}`,
                                  })),
                                ]}
                                onChange={(event) => {
                                  setExistingDefect(event.target.value);
                                }}
                              />
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={existingDefect === ''}
                                onClick={() => {
                                  mutate.mutate(() =>
                                    exploratoryApi.linkFinding(data.id, finding.id, existingDefect),
                                  );
                                }}
                              >
                                {t('exploratorySessionDetail.linkDefectTo')} {finding.title}
                              </Button>
                            </>
                          )}
                        </div>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
            <h3>{t('exploratorySessionDetail.relatedWorkItems')}</h3>
            <ul className="plain-list">
              {data.workItems.map((item) => (
                <li key={item.id}>
                  <Link to={`/work-items/${item.id}`}>{item.key}</Link> {item.title}
                </li>
              ))}
            </ul>
            {open && canRun && (
              <div className="row-actions">
                <SelectField
                  label={t('exploratorySessionDetail.workItem')}
                  value={workItemId}
                  options={[
                    { value: '', label: t('exploratorySessionDetail.chooseAWorkItem') },
                    ...(workItems.data?.data ?? []).map((entry) => ({
                      value: entry.id,
                      label: `${entry.key} ${entry.title}`,
                    })),
                  ]}
                  onChange={(event) => {
                    setWorkItemId(event.target.value);
                  }}
                />
                <Button
                  variant="secondary"
                  disabled={workItemId === ''}
                  onClick={() => {
                    mutate.mutate(() => exploratoryApi.linkWorkItem(data.id, workItemId));
                  }}
                >
                  {t('exploratorySessionDetail.linkWorkItem')}
                </Button>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="session-timeline">
            <h2 id="session-timeline">{t('exploratorySessionDetail.timeline')}</h2>
            {recording && canRun && (
              <form
                className="row-actions"
                onSubmit={(event) => {
                  event.preventDefault();
                  mutate.mutate(async () => {
                    await exploratoryApi.note(data.id, note.trim());
                    setNote('');
                  });
                }}
              >
                <TextField
                  label={t('exploratorySessionDetail.timelineNote')}
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                />
                <Button type="submit" disabled={note.trim() === ''}>
                  {t('exploratorySessionDetail.addNote')}
                </Button>
              </form>
            )}
            <ol aria-label={t('exploratorySessionDetail.timeline')}>
              {data.timeline.map((event) => (
                <li key={event.id}>
                  <span className="muted">{formatDateTime(event.createdAt)}</span>{' '}
                  <strong>{humanize(event.type)}</strong>
                  {event.body !== null && ` — ${event.body}`}
                  {event.actor !== null && <span className="muted"> · {event.actor.fullName}</span>}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </DataState>
  );
}
