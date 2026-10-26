import type { RequirementImplementation } from '@qa-flow-hub/shared';
import { Badge, type BadgeTone } from '@qa-flow-hub/ui';
import { humanize } from './status';

const TONE: Record<RequirementImplementation['state'], BadgeTone> = {
  not_implemented: 'neutral',
  partially_implemented: 'warning',
  implemented: 'success',
};

/** "Partially implemented · 1/2" for a requirement's implementing work items. */
export function ImplementationBadge({
  implementation,
}: {
  implementation: RequirementImplementation | undefined;
}): React.JSX.Element | null {
  if (implementation === undefined) {
    return null;
  }
  const countable = implementation.workItems - implementation.cancelled;
  return (
    <Badge tone={TONE[implementation.state]}>
      {humanize(implementation.state)}
      {countable > 0 ? ` · ${implementation.done}/${countable}` : ''}
    </Badge>
  );
}
