import type { ReactNode } from 'react';

export interface DataStateProps {
  isPending: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyMessage?: string;
  emptyAction?: ReactNode;
  children: ReactNode;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
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
  emptyMessage = 'Nothing here yet',
  emptyAction,
  children,
}: DataStateProps): React.JSX.Element {
  if (isPending) {
    return (
      <p className="ui-state" role="status">
        Loading…
      </p>
    );
  }

  if (error !== null && error !== undefined) {
    return (
      <p className="ui-state ui-state--error" role="alert">
        {messageOf(error)}
      </p>
    );
  }

  if (isEmpty) {
    return (
      <div className="ui-state ui-state--empty">
        <p>{emptyMessage}</p>
        {emptyAction}
      </div>
    );
  }

  return <>{children}</>;
}
