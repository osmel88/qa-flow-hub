import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'danger' | 'warning';

/**
 * Colour is never the only signal: the label is always readable text, so the
 * component works for a colour-blind user and in a screenshot pasted into a
 * report.
 */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}): React.JSX.Element {
  return <span className={`ui-badge ui-badge--${tone}`}>{children}</span>;
}
