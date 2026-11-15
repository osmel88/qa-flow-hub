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

const ACTIONS: Array<{ action: ExploratoryAction; label: string; from: ExploratoryStatus[] }> = [
  { action: 'start', label: 'Start session', from: ['planned'] },
  { action: 'pause', label: 'Pause session', from: ['active'] },
  { action: 'resume', label: 'Resume session', from: ['paused'] },
  { action: 'complete', label: 'Complete session', from: ['active', 'paused'] },
  { action: 'cancel', label: 'Cancel session', from: ['planned', 'active', 'paused'] },
  { action: 'archive', label: 'Archive session', from: ['planned', 'completed', 'cancelled'] },
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
      setError(cause instanceof ApiError ? cause.message : 'Could not update the session.');
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
          <PageHeader title={`Session ${data.title}`} description={data.charter} />
          <p>
            <Link to="/exploratory-sessions">← Exploratory testing</Link>
          </p>
          {error !== null && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <section className="card" aria-labelledby="session-summary">
            <h2 id="session-summary">Summary</h2>
            <p>
              <Badge tone={EXPLORATORY_TONE[data.status]}>
                <span data-testid="session-status">{data.status}</span>
              </Badge>{' '}
              Owner {data.owner?.fullName ?? 'nobody'} · Environment{' '}
              {data.environment?.name ?? 'none'} · Release{' '}
              {data.release === null ? 'none' : data.release.version}
              {data.testPlan !== null && (
                <>
                  {' '}
                  · Plan <Link to={`/test-plans/${data.testPlan.id}`}>{data.testPlan.name}</Link>
                </>
              )}
              {data.testCycle !== null && (
                <>
                  {' '}
                  · Cycle{' '}
                  <Link to={`/test-cycles/${data.testCycle.id}`}>{data.testCycle.name}</Link>
                </>
              )}
            </p>
            <p data-testid="session-metrics">
              Duration {formatDuration(data.metrics.durationSeconds)}
              {data.metrics.timeboxMinutes !== null && ` of ${data.metrics.timeboxMinutes}m`} ·{' '}
              {data.metrics.findings} findings · {data.metrics.defectsCreated} defects created ·{' '}
              {data.metrics.defectsLinked} defects related · {data.metrics.notes} notes
            </p>
            <p className="muted">
              Severity:{' '}
              {Object.entries(data.metrics.bySeverity)
                .filter(([, count]) => count > 0)
                .map(([name, count]) => `${name} ${count}`)
                .join(', ') || 'no findings'}
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
            <h2 id="session-notes">Notes and risks</h2>
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
                  label="Session notes"
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                  }}
                />
                <TextAreaField
                  label="Risks"
                  value={risks}
                  onChange={(event) => {
                    setRisks(event.target.value);
                  }}
                />
                <Button type="submit">Save session</Button>
              </form>
            ) : (
              <>
                <p>{data.notes ?? 'No notes.'}</p>
                <p className="muted">Risks: {data.risks ?? 'none'}</p>
              </>
            )}
            <h3>Attachments and links</h3>
            <ul className="plain-list" aria-label="Session links">
              {data.links.map((link) => (
                <li key={`${link.label}-${link.url}`}>
                  {link.kind === 'attachment' ? 'Attachment' : 'Link'}:{' '}
                  <a href={link.url} rel="noreferrer noopener" target="_blank">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
            {open && canRun && (
              <div className="row-actions">
                <TextField
                  label="Link label"
                  value={linkLabel}
                  onChange={(event) => {
                    setLinkLabel(event.target.value);
                  }}
                />
                <TextField
                  label="Link URL"
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
                  Add link
                </Button>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="session-findings">
            <h2 id="session-findings">Findings</h2>
            {recording && canRun && (
              <form
                aria-label="New finding"
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
                  label="Finding title"
                  value={findingTitle}
                  onChange={(event) => {
                    setFindingTitle(event.target.value);
                  }}
                />
                <TextAreaField
                  label="Finding description"
                  value={findingDescription}
                  onChange={(event) => {
                    setFindingDescription(event.target.value);
                  }}
                />
                <SelectField
                  label="Finding kind"
                  value={kind}
                  options={FINDING_KINDS.map((entry) => ({ value: entry, label: humanize(entry) }))}
                  onChange={(event) => {
                    setKind(event.target.value);
                  }}
                />
                <SelectField
                  label="Finding severity"
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
                  Record finding
                </Button>
              </form>
            )}
            {data.findings.length === 0 ? (
              <p className="muted">No finding yet.</p>
            ) : (
              <ul className="plain-list" aria-label="Findings">
                {data.findings.map((finding) => (
                  <li key={finding.id} data-testid={`finding-${finding.title}`}>
                    <strong>{finding.title}</strong> · {humanize(finding.kind)} · {finding.severity}
                    {finding.description !== null && (
                      <div className="muted">{finding.description}</div>
                    )}
                    {finding.defect !== null ? (
                      <div>
                        {finding.defectCreated ? 'Defect created' : 'Related defect'}:{' '}
                        <Link to="/defects">{finding.defect.key}</Link> {finding.defect.title}
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
                              Create defect from {finding.title}
                            </Button>
                          )}
                          {canRun && (
                            <>
                              <SelectField
                                label={`Existing defect for ${finding.title}`}
                                value={existingDefect}
                                options={[
                                  { value: '', label: 'Choose a defect' },
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
                                Link defect to {finding.title}
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
            <h3>Related work items</h3>
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
                  label="Work item"
                  value={workItemId}
                  options={[
                    { value: '', label: 'Choose a work item' },
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
                  Link work item
                </Button>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="session-timeline">
            <h2 id="session-timeline">Timeline</h2>
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
                  label="Timeline note"
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                />
                <Button type="submit" disabled={note.trim() === ''}>
                  Add note
                </Button>
              </form>
            )}
            <ol aria-label="Timeline">
              {data.timeline.map((event) => (
                <li key={event.id}>
                  <span className="muted">{new Date(event.createdAt).toLocaleString()}</span>{' '}
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
