import { DEVELOPMENT_STATUS_VALUES } from '@qa-flow-hub/shared';
import type { DevelopmentStatus } from '@qa-flow-hub/shared';
import type { BadgeTone } from '@qa-flow-hub/ui';
import { Badge } from '@qa-flow-hub/ui';
import { humanize } from './status';

export const DEVELOPMENT_STATUS_TONE: Record<DevelopmentStatus, BadgeTone> = {
  no_development: 'neutral',
  branch_created: 'neutral',
  commits: 'neutral',
  pr_open: 'info',
  pr_approved: 'info',
  merged: 'success',
  build_running: 'info',
  build_passed: 'success',
  build_failed: 'danger',
  deployed: 'success',
};

/** Options of a development status filter (S5-F2). */
export const DEVELOPMENT_STATUS_OPTIONS = [
  { value: '', label: 'Any development' },
  ...DEVELOPMENT_STATUS_VALUES.map((value) => ({ value, label: humanize(value) })),
];

/** Derived development status; nothing for items without development. */
export function DevelopmentStatusBadge({
  status,
  testId,
}: {
  status: DevelopmentStatus | undefined;
  testId?: string;
}): React.JSX.Element | null {
  if (status === undefined || status === 'no_development') {
    return null;
  }
  return (
    <span data-testid={testId} title="Development status">
      <Badge tone={DEVELOPMENT_STATUS_TONE[status]}>{humanize(status)}</Badge>
    </span>
  );
}
