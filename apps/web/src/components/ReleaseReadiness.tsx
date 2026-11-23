import { DEFECT_SEVERITIES } from '@qa-flow-hub/shared';
import type { ReadinessDecision, ReadinessReason, ReleaseReadinessView } from '@qa-flow-hub/shared';
import { Badge, DataState } from '@qa-flow-hub/ui';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { releasesApi } from '../api/endpoints';
import { t } from '../i18n/i18n';
import { formatDateTime } from '../i18n/format';
import type { MessageKey } from '../i18n/messages/en';
import { formatNumber, formatPercent } from './analytics/charts';
import { humanize } from './status';

export const READINESS_TONE: Record<ReadinessDecision, BadgeTone> = {
  go: 'success',
  go_with_risks: 'warning',
  no_go: 'danger',
  insufficient_data: 'neutral',
};

const MAX_ITEMS = 5;

export function decisionLabel(decision: ReadinessDecision): string {
  return t(`releaseReadiness.decision.${decision}` as MessageKey);
}

/** Localized from `code`; the API's English `message` stays for API consumers. */
export function reasonText(reason: ReadinessReason, view: ReleaseReadinessView): string {
  return t(`releaseReadiness.reason.${reason.code}` as MessageKey, {
    count: reason.count,
    max: view.thresholds.maxFailedRate,
    min: view.thresholds.minVerdicts,
  });
}

function ReasonList({
  id,
  title,
  reasons,
  view,
}: {
  id: string;
  title: string;
  reasons: ReadinessReason[];
  view: ReleaseReadinessView;
}): React.JSX.Element {
  return (
    <section aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {reasons.length === 0 ? (
        <p className="muted">{t('releaseReadiness.none')}</p>
      ) : (
        <ul>
          {reasons.map((reason) => (
            <li key={reason.code}>
              <strong>{reasonText(reason, view)}</strong>{' '}
              <span className="muted">
                ({t(`releaseReadiness.source.${reason.source}` as MessageKey)})
              </span>
              {reason.items.length > 0 && (
                <ul>
                  {reason.items.slice(0, MAX_ITEMS).map((item) => (
                    <li key={item.id}>{item.label}</li>
                  ))}
                  {reason.items.length > MAX_ITEMS && (
                    <li className="muted">
                      {t('releaseReadiness.andMore', { count: reason.items.length - MAX_ITEMS })}
                    </li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Kpi = [label: string, value: string];
const label = (text: string, value: string): Kpi => [text, value];
const k = (key: MessageKey, value: string): Kpi => [t(key), value];

function Kpis({ items }: { items: Kpi[] }): React.JSX.Element {
  return (
    <dl className="kpis">
      {items.map(([text, value]) => (
        <div key={text}>
          <dt>{text}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The whole report; shared by Release Detail and the printable page. */
export function ReadinessReport({ view }: { view: ReleaseReadinessView }): React.JSX.Element {
  const m = view.metrics;
  const n = (value: number) => formatNumber(value);
  const gateResult = (result: string) => t(`releaseReadiness.gateResult.${result}` as MessageKey);
  const progressRows = [
    ...m.plans.map((row) => ({ ...row, kind: t('releaseReadiness.plan') })),
    ...m.cycles.map((row) => ({ ...row, kind: t('releaseReadiness.cycle') })),
  ];

  return (
    <div className="readiness">
      <p>
        <span className="muted">{t('releaseReadiness.decisionLabel')}: </span>
        <Badge tone={READINESS_TONE[view.decision]}>{decisionLabel(view.decision)}</Badge>
      </p>
      <p>
        {t(`releaseReadiness.summary.${view.decision}` as MessageKey, {
          blockers: view.blockers.length,
          warnings: view.warnings.length,
        })}
      </p>
      <p className="muted">
        {t('releaseReadiness.computedAt', { date: formatDateTime(view.computedAt) })} ·{' '}
        {t('releaseReadiness.thresholds', {
          minVerdicts: view.thresholds.minVerdicts,
          maxFailedRate: view.thresholds.maxFailedRate,
        })}
      </p>
      <ReasonList
        id="readiness-reasons"
        title={t('releaseReadiness.reasons')}
        reasons={view.reasons}
        view={view}
      />
      <ReasonList
        id="readiness-blockers"
        title={t('releaseReadiness.blockers')}
        reasons={view.blockers}
        view={view}
      />
      <ReasonList
        id="readiness-warnings"
        title={t('releaseReadiness.warnings')}
        reasons={view.warnings}
        view={view}
      />

      <h3>{t('releaseReadiness.qualityGates')}</h3>
      {m.qualityGates.gates.length === 0 ? (
        <p className="muted">{t('releaseReadiness.noGates')}</p>
      ) : (
        <>
          <p>
            {t('releaseReadiness.requiredResult', {
              result: gateResult(m.qualityGates.required.result),
              count: m.qualityGates.required.gateCount,
            })}
          </p>
          <table className="table" aria-label={t('releaseReadiness.qualityGates')}>
            <thead>
              <tr>
                <th scope="col">{t('releaseReadiness.gate')}</th>
                <th scope="col">{t('releaseReadiness.required')}</th>
                <th scope="col">{t('releaseReadiness.result')}</th>
              </tr>
            </thead>
            <tbody>
              {m.qualityGates.gates.map((gate) => (
                <tr key={gate.id}>
                  <td>{gate.name}</td>
                  <td>{gate.required ? t('releaseReadiness.yes') : t('releaseReadiness.no')}</td>
                  <td>{gateResult(gate.result)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>{t('releaseReadiness.execution')}</h3>
      <Kpis
        items={[
          k('releaseReadiness.runs', n(m.execution.runs.length)),
          k('releaseReadiness.planned', n(m.execution.kpis.planned)),
          k('releaseReadiness.executed', n(m.execution.kpis.executed)),
          k('releaseReadiness.pending', n(m.execution.kpis.pending)),
          k('releaseReadiness.passRate', formatPercent(m.execution.rates.passRate)),
          k('releaseReadiness.failedRate', formatPercent(m.execution.rates.failedRate)),
          k('releaseReadiness.blockedRate', formatPercent(m.execution.rates.blockedRate)),
          k('releaseReadiness.progress', formatPercent(m.execution.kpis.progress)),
        ]}
      />
      {m.execution.rates.passRate === null && m.execution.kpis.verdicts > 0 && (
        <p className="muted">
          {t('releaseReadiness.sampleTooSmall', { min: view.thresholds.minVerdicts })}
        </p>
      )}

      <h3>{t('releaseReadiness.plansCycles')}</h3>
      {progressRows.length === 0 ? (
        <p className="muted">{t('releaseReadiness.noPlansCycles')}</p>
      ) : (
        <table className="table" aria-label={t('releaseReadiness.plansCycles')}>
          <thead>
            <tr>
              <th scope="col">{t('releaseReadiness.kind')}</th>
              <th scope="col">{t('releaseReadiness.name')}</th>
              <th scope="col">{t('releaseReadiness.status')}</th>
              <th scope="col">{t('releaseReadiness.completion')}</th>
              <th scope="col">{t('releaseReadiness.passRate')}</th>
            </tr>
          </thead>
          <tbody>
            {progressRows.map((row) => (
              <tr key={row.id}>
                <td>{row.kind}</td>
                <td>{row.name}</td>
                <td>{humanize(row.status)}</td>
                <td>{formatPercent(row.completion)}</td>
                <td>{formatPercent(row.passRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>{t('releaseReadiness.defects')}</h3>
      <Kpis
        items={[
          k('releaseReadiness.openDefects', n(m.defects.open)),
          k('releaseReadiness.reopened', n(m.defects.reopened)),
          ...DEFECT_SEVERITIES.map((severity) =>
            label(humanize(severity), n(m.defects.bySeverity[severity])),
          ),
        ]}
      />

      <h3>{t('releaseReadiness.requirements')}</h3>
      <Kpis
        items={[
          k('releaseReadiness.totalRequirements', n(m.requirements.total)),
          k('releaseReadiness.covered', n(m.requirements.covered)),
          k('releaseReadiness.uncovered', n(m.requirements.uncovered)),
          k('releaseReadiness.coveredNotExecuted', n(m.requirements.coveredNotExecuted)),
          k('releaseReadiness.failingRequirements', n(m.requirements.failing)),
          k('releaseReadiness.coverage', formatPercent(m.requirements.coverage)),
        ]}
      />

      <h3>{t('releaseReadiness.flaky')}</h3>
      <Kpis
        items={[
          k('releaseReadiness.flakyCount', n(m.flaky.flaky)),
          k('releaseReadiness.suspect', n(m.flaky.suspect)),
          k('releaseReadiness.failing', n(m.flaky.failing)),
          k('releaseReadiness.confirmed', n(m.flaky.confirmed)),
          k('releaseReadiness.dismissed', n(m.flaky.dismissed)),
        ]}
      />

      <h3>{t('releaseReadiness.exploratory')}</h3>
      <Kpis
        items={[
          k('releaseReadiness.sessions', n(m.exploratory.sessions)),
          k('releaseReadiness.incompleteSessions', n(m.exploratory.incomplete)),
          k('releaseReadiness.findings', n(m.exploratory.findings)),
          k('releaseReadiness.openFindings', n(m.exploratory.openFindings)),
          k('releaseReadiness.convertedFindings', n(m.exploratory.convertedFindings)),
        ]}
      />
    </div>
  );
}

export function ReleaseReadinessSection({ releaseId }: { releaseId: string }): React.JSX.Element {
  const readiness = useQuery({
    queryKey: ['releases', 'readiness', releaseId],
    queryFn: () => releasesApi.readiness(releaseId),
  });
  return (
    <section className="card" aria-labelledby="release-readiness">
      <h2 id="release-readiness">{t('releaseReadiness.title')}</h2>
      <p className="muted">{t('releaseReadiness.description')}</p>
      <p>
        <Link to={`/print/releases/${releaseId}/readiness`} target="_blank" rel="noopener">
          {t('releaseReadiness.printable')}
        </Link>
      </p>
      <DataState isPending={readiness.isPending} error={readiness.error} isEmpty={false}>
        {readiness.data !== undefined && <ReadinessReport view={readiness.data} />}
      </DataState>
    </section>
  );
}
