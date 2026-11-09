import { Button, TextField } from '@qa-flow-hub/ui';
import type { TestCaseDetailView, VersionDiffView } from '@qa-flow-hub/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { testDesignApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';

interface TestCaseHistoryProps {
  detail: TestCaseDetailView;
  canWrite: boolean;
}

const show = (value: string | null) => (value === null || value === '' ? '—' : value);

/**
 * Version history of a case (S7-F4): every content version, a diff between
 * any two, and restore, which copies an old version into a new one.
 */
export function TestCaseHistory({ detail, canWrite }: TestCaseHistoryProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const requested = Number(params.get('version'));
  const [viewing, setViewing] = useState<number | null>(
    Number.isInteger(requested) && requested > 0 ? requested : null,
  );
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const versions = useQuery({
    queryKey: ['case-versions', detail.id, detail.version],
    queryFn: () => testDesignApi.versions(detail.id),
  });
  const viewed = useQuery({
    queryKey: ['case-version', detail.id, viewing],
    queryFn: () => testDesignApi.version(detail.id, viewing ?? 1),
    enabled: viewing !== null,
  });
  const diff = useQuery({
    queryKey: ['case-version-diff', detail.id, from, to],
    queryFn: () => testDesignApi.diffVersions(detail.id, from ?? 1, to ?? 1),
    enabled: from !== null && to !== null && from !== to,
  });

  const restore = useMutation({
    mutationFn: (version: number) =>
      testDesignApi.restoreVersion(detail.id, version, {
        version: detail.version,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      }),
    onSuccess: async (updated, version) => {
      setError(null);
      setReason('');
      setMessage(`Restored version ${version} as version ${updated.version}.`);
      await queryClient.invalidateQueries({ queryKey: ['case', detail.id] });
      await queryClient.invalidateQueries({ queryKey: ['case-versions', detail.id] });
    },
    onError: (cause) => {
      setMessage(null);
      setError(cause instanceof ApiError ? cause.message : 'Could not restore the version.');
    },
  });

  const rows = versions.data ?? [];

  return (
    <section className="card" aria-labelledby="case-history-heading">
      <h2 id="case-history-heading">Version history</h2>
      <p className="muted">
        Current version: {detail.version}. Runs, results and frozen plans keep the version they
        used.
      </p>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {message !== null && (
        <p className="ui-state" role="status">
          {message}
        </p>
      )}
      <table className="table" aria-label="Versions">
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Author</th>
            <th scope="col">Date</th>
            <th scope="col">Reason</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid={`case-version-${row.version}`}>
              <td>
                v{row.version}
                {row.current && ' (current)'}
                {row.restoredFromVersion !== null && ` · restored from v${row.restoredFromVersion}`}
              </td>
              <td>{row.author?.fullName ?? 'unknown'}</td>
              <td>{new Date(row.createdAt).toLocaleString()}</td>
              <td>{show(row.changeReason)}</td>
              <td className="row-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setViewing(row.version);
                  }}
                >
                  View version {row.version}
                </Button>
                {canWrite && !row.current && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={restore.isPending && restore.variables === row.version}
                    onClick={() => {
                      restore.mutate(row.version);
                    }}
                  >
                    Restore version {row.version}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canWrite && (
        <TextField
          label="Restore reason (optional)"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      )}

      <h3>Compare versions</h3>
      <div className="row-actions">
        <label>
          Compare from
          <select
            value={from ?? ''}
            onChange={(event) => {
              setFrom(event.target.value === '' ? null : Number(event.target.value));
            }}
          >
            <option value="">Choose</option>
            {rows.map((row) => (
              <option key={row.id} value={row.version}>
                v{row.version}
              </option>
            ))}
          </select>
        </label>
        <label>
          Compare to
          <select
            value={to ?? ''}
            onChange={(event) => {
              setTo(event.target.value === '' ? null : Number(event.target.value));
            }}
          >
            <option value="">Choose</option>
            {rows.map((row) => (
              <option key={row.id} value={row.version}>
                v{row.version}
              </option>
            ))}
          </select>
        </label>
      </div>
      {diff.data !== undefined && <VersionDiff diff={diff.data} />}

      {viewing !== null && viewed.data !== undefined && (
        <div aria-label={`Version ${viewing} content`}>
          <h3>
            Version {viewed.data.version}
            {viewed.data.current ? ' (current)' : ''}
          </h3>
          <dl>
            <dt>Title</dt>
            <dd>{viewed.data.content.title}</dd>
            <dt>Description</dt>
            <dd>{show(viewed.data.content.description)}</dd>
            <dt>Preconditions</dt>
            <dd>{show(viewed.data.content.preconditions)}</dd>
            <dt>Expected result</dt>
            <dd>{show(viewed.data.content.expectedResult)}</dd>
            <dt>Type and priority</dt>
            <dd>
              {viewed.data.content.type} · {viewed.data.content.priority}
            </dd>
            <dt>Parameters</dt>
            <dd>
              {viewed.data.content.parameters.map((parameter) => parameter.name).join(', ') ||
                'none'}{' '}
              ({viewed.data.content.dataset.length} dataset rows)
            </dd>
          </dl>
          <ol>
            {viewed.data.content.steps.map((step) => (
              <li key={step.position}>
                {step.action}
                {step.expectedResult !== null && (
                  <div className="muted">Expected: {step.expectedResult}</div>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function VersionDiff({ diff }: { diff: VersionDiffView }): React.JSX.Element {
  if (diff.identical) {
    return (
      <p className="muted">
        Versions {diff.from} and {diff.to} have the same content.
      </p>
    );
  }
  return (
    <ul className="plain-list" aria-label="Differences">
      {diff.fields.map((change) => (
        <li key={change.field}>
          <strong>{change.field}</strong>: <del>{show(change.before)}</del> →{' '}
          <ins>{show(change.after)}</ins>
        </li>
      ))}
      {diff.steps.map((change) => (
        <li key={`step-${change.position}`}>
          <strong>
            Step {change.position} {change.change}
          </strong>
          : <del>{change.before?.action ?? '—'}</del> → <ins>{change.after?.action ?? '—'}</ins>
        </li>
      ))}
      {diff.parameters.map((change) => (
        <li key={`parameter-${change.name}`}>
          <strong>
            Parameter {change.name} {change.change}
          </strong>
        </li>
      ))}
      {diff.dataset.changed && (
        <li>
          <strong>Dataset changed</strong>: {diff.dataset.before} → {diff.dataset.after} rows
        </li>
      )}
    </ul>
  );
}
