import { Button, TextField } from '@qa-flow-hub/ui';
import type { TestCaseDetailView, VersionDiffView } from '@qa-flow-hub/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { testDesignApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';

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
      setMessage(
        t('testCaseHistory.restoredVersionAsVersion', { version, version2: updated.version }),
      );
      await queryClient.invalidateQueries({ queryKey: ['case', detail.id] });
      await queryClient.invalidateQueries({ queryKey: ['case-versions', detail.id] });
    },
    onError: (cause) => {
      setMessage(null);
      setError(
        cause instanceof ApiError ? cause.message : t('testCaseHistory.couldNotRestoreTheVersion'),
      );
    },
  });

  const rows = versions.data ?? [];

  return (
    <section className="card" aria-labelledby="case-history-heading">
      <h2 id="case-history-heading">{t('testCaseHistory.versionHistory')}</h2>
      <p className="muted">
        {t('testCaseHistory.currentVersion')} {detail.version}
        {t('testCaseHistory.runsResultsAndFrozenPlans')}
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
      <table className="table" aria-label={t('testCaseHistory.versions')}>
        <thead>
          <tr>
            <th scope="col">{t('testCaseHistory.version')}</th>
            <th scope="col">{t('testCaseHistory.author')}</th>
            <th scope="col">{t('testCaseHistory.date')}</th>
            <th scope="col">{t('testCaseHistory.reason')}</th>
            <th scope="col">{t('testCaseHistory.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid={`case-version-${row.version}`}>
              <td>
                v{row.version}
                {row.current && t('testCaseHistory.currentSuffix')}
                {row.restoredFromVersion !== null &&
                  t('testCaseHistory.restoredFrom', { version: row.restoredFromVersion })}
              </td>
              <td>{row.author?.fullName ?? t('testCaseHistory.unknown')}</td>
              <td>{formatDateTime(row.createdAt)}</td>
              <td>{show(row.changeReason)}</td>
              <td className="row-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setViewing(row.version);
                  }}
                >
                  {t('testCaseHistory.viewVersion')} {row.version}
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
                    {t('testCaseHistory.restoreVersion')} {row.version}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canWrite && (
        <TextField
          label={t('testCaseHistory.restoreReasonOptional')}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      )}

      <h3>{t('testCaseHistory.compareVersions')}</h3>
      <div className="row-actions">
        <label>
          {t('testCaseHistory.compareFrom')}
          <select
            value={from ?? ''}
            onChange={(event) => {
              setFrom(event.target.value === '' ? null : Number(event.target.value));
            }}
          >
            <option value="">{t('testCaseHistory.choose')}</option>
            {rows.map((row) => (
              <option key={row.id} value={row.version}>
                v{row.version}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('testCaseHistory.compareTo')}
          <select
            value={to ?? ''}
            onChange={(event) => {
              setTo(event.target.value === '' ? null : Number(event.target.value));
            }}
          >
            <option value="">{t('testCaseHistory.choose')}</option>
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
        <div aria-label={t('testCaseHistory.versionContent', { viewing })}>
          <h3>
            {t('testCaseHistory.version')} {viewed.data.version}
            {viewed.data.current ? t('testCaseHistory.current') : ''}
          </h3>
          <dl>
            <dt>{t('testCaseHistory.title')}</dt>
            <dd>{viewed.data.content.title}</dd>
            <dt>{t('testCaseHistory.description')}</dt>
            <dd>{show(viewed.data.content.description)}</dd>
            <dt>{t('testCaseHistory.preconditions')}</dt>
            <dd>{show(viewed.data.content.preconditions)}</dd>
            <dt>{t('testCaseHistory.expectedResult')}</dt>
            <dd>{show(viewed.data.content.expectedResult)}</dd>
            <dt>{t('testCaseHistory.typeAndPriority')}</dt>
            <dd>
              {viewed.data.content.type} · {viewed.data.content.priority}
            </dd>
            <dt>{t('testCaseHistory.parameters')}</dt>
            <dd>
              {viewed.data.content.parameters.map((parameter) => parameter.name).join(', ') ||
                t('testCaseHistory.none')}{' '}
              ({viewed.data.content.dataset.length} {t('testCaseHistory.datasetRows')}
            </dd>
          </dl>
          <ol>
            {viewed.data.content.steps.map((step) => (
              <li key={step.position}>
                {step.action}
                {step.expectedResult !== null && (
                  <div className="muted">
                    {t('testCaseHistory.expected')} {step.expectedResult}
                  </div>
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
        {t('testCaseHistory.versions')} {diff.from} {t('testCaseHistory.and')} {diff.to}{' '}
        {t('testCaseHistory.haveTheSameContent')}
      </p>
    );
  }
  return (
    <ul className="plain-list" aria-label={t('testCaseHistory.differences')}>
      {diff.fields.map((change) => (
        <li key={change.field}>
          <strong>{change.field}</strong>: <del>{show(change.before)}</del> →{' '}
          <ins>{show(change.after)}</ins>
        </li>
      ))}
      {diff.steps.map((change) => (
        <li key={`step-${change.position}`}>
          <strong>
            {t('testCaseHistory.step')} {change.position} {change.change}
          </strong>
          : <del>{change.before?.action ?? '—'}</del> → <ins>{change.after?.action ?? '—'}</ins>
        </li>
      ))}
      {diff.parameters.map((change) => (
        <li key={`parameter-${change.name}`}>
          <strong>
            {t('testCaseHistory.parameter')} {change.name} {change.change}
          </strong>
        </li>
      ))}
      {diff.dataset.changed && (
        <li>
          <strong>{t('testCaseHistory.datasetChanged')}</strong>: {diff.dataset.before} →{' '}
          {diff.dataset.after} {t('testCaseHistory.rows')}
        </li>
      )}
    </ul>
  );
}
