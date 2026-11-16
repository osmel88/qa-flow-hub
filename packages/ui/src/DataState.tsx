import type { ReactNode } from 'react';
import { useUiStrings } from './UiStrings';

export interface DataStateProps {
  isPending: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyMessage?: string;
  emptyAction?: ReactNode;
  children: ReactNode;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Loading, error and empty in one place.
 *
 * Written as a component rather than three copies per screen because the empty
 * state is the one that always gets skipped, and a table that renders zero rows
 * with no explanation reads as a bug to the user.
 */
export function DataState({
  isPending,
  error,
  isEmpty = false,
  emptyMessage,
  emptyAction,
  children,
}: DataStateProps): React.JSX.Element {
  const strings = useUiStrings();
  if (isPending) {
    return (
      <p className="ui-state" role="status">
        {strings.loading}
      </p>
    );
  }

  if (error !== null && error !== undefined) {
    return (
      <p className="ui-state ui-state--error" role="alert">
        {messageOf(error, strings.genericError)}
      </p>
    );
  }

  if (isEmpty) {
    return (
      <div className="ui-state ui-state--empty">
        <p>{emptyMessage ?? strings.empty}</p>
        {emptyAction}
      </div>
    );
  }

  return <>{children}</>;
}
