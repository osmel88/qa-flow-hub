import type {
  ExternalReferenceView,
  ListTestRailReferencesQuery,
  TestRailSyncableEntity,
} from '@qa-flow-hub/shared';
import { Button } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { testRailApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';

/**
 * One query for the whole table, not one per row: the TestRail references of
 * every suite, case or run in the project (or every result in a run) come back
 * together and each cell picks its own.
 */
export function useTestRailReferences(query: ListTestRailReferencesQuery, enabled = true) {
  return useQuery({
    queryKey: ['testrail-references', query],
    queryFn: () => testRailApi.references(query),
    enabled,
    select: (references): Map<string, ExternalReferenceView> =>
      new Map(references.map((reference) => [reference.entityId, reference])),
  });
}

interface TestRailSyncCellProps {
  entityType: TestRailSyncableEntity;
  entityId: string;
  reference: ExternalReferenceView | undefined;
}

/**
 * Shows the TestRail object an entity is linked to, and the button that creates
 * or refreshes it. A sync may also create what the entity depends on (a case
 * brings its suite, a run its cases), so every TestRail column is refreshed
 * afterwards, not only this one.
 */
export function TestRailSyncCell({
  entityType,
  entityId,
  reference,
}: TestRailSyncCellProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const sync = useMutation({
    mutationFn: () => testRailApi.sync(entityType, entityId),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['testrail-references'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not sync with TestRail.');
    },
  });

  const label = reference?.externalKey ?? reference?.externalId;

  return (
    <div className="external-sync">
      {reference !== undefined &&
        (reference.externalUrl === null ? (
          <code>{label}</code>
        ) : (
          <a href={reference.externalUrl} target="_blank" rel="noreferrer">
            <code>{label}</code>
          </a>
        ))}
      <Button
        size="sm"
        variant="secondary"
        loading={sync.isPending}
        onClick={() => {
          sync.mutate();
        }}
      >
        {reference === undefined ? 'Sync to TestRail' : 'Re-sync'}
      </Button>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
