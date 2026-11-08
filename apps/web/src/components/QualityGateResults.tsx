import type { GateLink, GateResult, ReleaseQualityGatesView } from '@qa-flow-hub/shared';
import { QUALITY_GATE_RULE_LABELS } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge } from '@qa-flow-hub/ui';
import { Link } from 'react-router-dom';
import { humanize } from './status';

export const GATE_TONE: Record<GateResult, BadgeTone> = {
  passed: 'success',
  failed: 'danger',
  pending: 'warning',
  not_applicable: 'neutral',
};

const LINK_PATH: Record<GateLink['kind'], (id: string) => string> = {
  test_run: (id) => `/test-runs/${id}`,
  defect: () => '/defects',
  build: (id) => `/builds/${id}`,
  code_review: (id) => `/code-reviews/${id}`,
  requirement: (id) => `/requirements/${id}`,
};

/** Every gate, every rule, why it got its result and what caused it (S6-F3). */
export function QualityGateResults({ view }: { view: ReleaseQualityGatesView }): React.JSX.Element {
  if (view.gates.length === 0) {
    return <p className="muted">No quality gate applies here.</p>;
  }
  return (
    <ul aria-label="Quality gate results">
      {view.gates.map((entry) => (
        <li key={entry.gate.id} data-testid={`gate-${entry.gate.name}`}>
          <strong>{entry.gate.name}</strong>{' '}
          <Badge tone={GATE_TONE[entry.result]}>{humanize(entry.result)}</Badge>{' '}
          <span className="muted">{entry.gate.required ? 'required' : 'advisory'}</span>
          <ul>
            {entry.rules.map((rule) => (
              <li key={rule.type} data-testid={`rule-${entry.gate.name}-${rule.type}`}>
                <Badge tone={GATE_TONE[rule.result]}>{humanize(rule.result)}</Badge>{' '}
                {QUALITY_GATE_RULE_LABELS[rule.type]}: {rule.message}
                {rule.links.length > 0 && (
                  <>
                    {' '}
                    ({' '}
                    {rule.links.map((link, index) => (
                      <span key={`${link.kind}-${link.id}`}>
                        {index > 0 && ', '}
                        <Link to={LINK_PATH[link.kind](link.id)}>{link.label}</Link>
                      </span>
                    ))}{' '}
                    )
                  </>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
