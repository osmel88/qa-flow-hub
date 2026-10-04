import type { ExecutionKpis, TrendPoint } from '@qa-flow-hub/shared';
import { useId } from 'react';
import { humanize } from '../status';

/**
 * Dependency-free, accessible chart primitives for the analytics dashboards.
 * Every visual carries its numbers as text (a value next to each bar, a legend
 * with counts, a data table behind each trend), and series are told apart by
 * line style and label as well as colour.
 */

export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

export function formatNumber(value: number | null): string {
  return value === null ? '—' : String(value);
}

export function Kpi({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}): React.JSX.Element {
  return (
    <div className="metric">
      <span className="metric__value">{value}</span>
      <span className="metric__label">{label}</span>
      {detail !== undefined && <span className="metric__detail">{detail}</span>}
    </div>
  );
}

export interface BarRow {
  key: string;
  label: React.ReactNode;
  value: number;
  display?: string;
}

/** Horizontal bars for comparisons; the value is always printed beside the bar. */
export function BarList({
  title,
  rows,
  max,
  empty = 'Nothing to compare yet.',
}: {
  title: string;
  rows: readonly BarRow[];
  max?: number;
  empty?: string;
}): React.JSX.Element {
  const scale = Math.max(max ?? Math.max(...rows.map((row) => row.value), 0), 1);
  return (
    <section className="card" aria-label={title}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="bar-list">
          {rows.map((row) => (
            <li key={row.key} className="bar-list__row">
              <span className="bar-list__label">{row.label}</span>
              <span className="bar-list__track" aria-hidden="true">
                <span
                  className="bar-list__fill"
                  style={{ width: `${Math.min(100, (row.value / scale) * 100)}%` }}
                />
              </span>
              <span className="bar-list__value">{row.display ?? String(row.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const EXECUTION_SEGMENTS = ['passed', 'failed', 'blocked', 'skipped', 'untested'] as const;

const SEGMENT_RATE: Record<(typeof EXECUTION_SEGMENTS)[number], keyof ExecutionKpis> = {
  passed: 'passRate',
  failed: 'failedRate',
  blocked: 'blockedRate',
  skipped: 'skippedRate',
  untested: 'untestedRate',
};

/** One stacked bar of the execution statuses plus a legend table with counts and rates. */
export function ExecutionDistribution({
  title,
  execution,
}: {
  title: string;
  execution: ExecutionKpis;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <section className="card" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {execution.planned === 0 ? (
        <p className="muted">No run case in this window.</p>
      ) : (
        <>
          <div className="distribution" aria-hidden="true">
            {EXECUTION_SEGMENTS.filter((status) => execution.counts[status] > 0).map((status) => (
              <span
                key={status}
                className={`distribution__segment distribution__segment--${status}`}
                style={{ flexGrow: execution.counts[status] }}
                title={`${humanize(status)}: ${execution.counts[status]}`}
              />
            ))}
          </div>
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Cases</th>
                <th scope="col">Rate</th>
              </tr>
            </thead>
            <tbody>
              {EXECUTION_SEGMENTS.map((status) => {
                const rate = execution[SEGMENT_RATE[status]];
                return (
                  <tr key={status}>
                    <th scope="row">
                      <span
                        className={`legend-swatch distribution__segment--${status}`}
                        aria-hidden="true"
                      />
                      {humanize(status)}
                    </th>
                    <td>{execution.counts[status]}</td>
                    <td>{typeof rate === 'number' ? `${rate}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted small">
            Pass, failed and blocked rates are over verdicts ({execution.verdicts}); skipped and
            untested are over planned cases ({execution.planned}).
          </p>
        </>
      )}
    </section>
  );
}

type TrendKey = 'passRate' | 'coverage' | 'defectsOpen' | 'defectsCreated' | 'defectsClosed';

export interface TrendSeriesSpec {
  key: TrendKey;
  label: string;
  /** `percent` series share a 0–100 axis; `count` series scale to their maximum. */
  unit: 'percent' | 'count';
}

const WIDTH = 600;
const HEIGHT = 160;
const PADDING = 8;
const DASHES = ['', '6 4', '2 3'];

function bucketLabel(point: TrendPoint): string {
  return point.bucketStart.slice(0, 10);
}

/**
 * A line chart over the trend buckets. Missing values (`null`) break the line
 * instead of being drawn as zero. The figure's data table is always available.
 */
export function TrendChart({
  title,
  points,
  series,
}: {
  title: string;
  points: readonly TrendPoint[];
  series: readonly TrendSeriesSpec[];
}): React.JSX.Element {
  const captionId = useId();
  const unit = series[0]?.unit ?? 'percent';
  const max =
    unit === 'percent'
      ? 100
      : Math.max(1, ...points.flatMap((point) => series.map((spec) => point[spec.key] ?? 0)));
  const step = points.length > 1 ? (WIDTH - 2 * PADDING) / (points.length - 1) : 0;
  const x = (index: number) => PADDING + index * step;
  const y = (value: number) => HEIGHT - PADDING - (value / max) * (HEIGHT - 2 * PADDING);

  const paths = series.map((spec) => {
    let d = '';
    let drawing = false;
    points.forEach((point, index) => {
      const value = point[spec.key];
      if (value === null) {
        drawing = false;
        return;
      }
      d += `${drawing ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)} `;
      drawing = true;
    });
    return d.trim();
  });

  const summary = series
    .map((spec) => {
      const values = points.map((point) => point[spec.key]).filter((value) => value !== null);
      if (values.length === 0) {
        return `${spec.label}: no data`;
      }
      const suffix = spec.unit === 'percent' ? '%' : '';
      return `${spec.label}: from ${values[0]}${suffix} to ${values.at(-1)}${suffix}`;
    })
    .join('; ');

  return (
    <figure className="card trend-chart" aria-labelledby={captionId}>
      <figcaption id={captionId}>
        <h3>{title}</h3>
      </figcaption>
      <ul className="trend-chart__legend">
        {series.map((spec, index) => (
          <li key={spec.key}>
            <svg width="28" height="10" aria-hidden="true">
              <line
                x1="0"
                y1="5"
                x2="28"
                y2="5"
                className={`trend-chart__line trend-chart__line--${index}`}
                strokeDasharray={DASHES[index]}
              />
            </svg>
            {spec.label}
          </li>
        ))}
      </ul>
      <svg
        className="trend-chart__plot"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}. ${summary}.`}
      >
        <line
          x1={PADDING}
          y1={HEIGHT - PADDING}
          x2={WIDTH - PADDING}
          y2={HEIGHT - PADDING}
          className="trend-chart__axis"
        />
        {paths.map((d, index) =>
          d === '' ? null : (
            <path
              key={series[index]?.key}
              d={d}
              className={`trend-chart__line trend-chart__line--${index}`}
              strokeDasharray={DASHES[index]}
              vectorEffect="non-scaling-stroke"
            />
          ),
        )}
      </svg>
      <p className="muted small">
        {points.length > 0 &&
          `${bucketLabel(points[0] as TrendPoint)} → ${bucketLabel(points.at(-1) as TrendPoint)}`}
        {unit === 'count' && ` · scale 0–${max}`}
      </p>
      <details>
        <summary>Show data table</summary>
        <div className="table-scroll">
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">Bucket</th>
                {series.map((spec) => (
                  <th key={spec.key} scope="col">
                    {spec.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.bucketStart}>
                  <th scope="row">{bucketLabel(point)}</th>
                  {series.map((spec) => (
                    <td key={spec.key}>
                      {spec.unit === 'percent'
                        ? formatPercent(point[spec.key])
                        : formatNumber(point[spec.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
