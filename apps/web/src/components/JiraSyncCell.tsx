import type { ExternalReferenceView, JiraSyncableEntity } from '@qa-flow-hub/shared';
import { Button } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { jiraApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';

/**
 * One query for the whole table, not one per row: the references of every
 * requirement (or defect) in the project come back together and each cell
 * picks its own.
 */
export function useJiraReferences(projectId: string, entityType: JiraSyncableEntity) {
  return useQuery({
    queryKey: ['jira-references', projectId, entityType],
    queryFn: () => jiraApi.references(projectId, entityType),
    enabled: projectId !== '',
    select: (references): Map<string, ExternalReferenceView> =>
      new Map(references.map((reference) => [reference.entityId, reference])),
  });
}

interface JiraSyncCellProps {
  entityType: JiraSyncableEntity;
  entityId: string;
  reference: ExternalReferenceView | undefined;
}

/**
 * Shows the Jira issue an entity is linked to, and the button that creates or
 * refreshes it. The action is the same whether the issue exists or not — the
 * API decides between create and update — so the button only changes its label.
 */
export function JiraSyncCell({
  entityType,
  entityId,
  reference,
}: JiraSyncCellProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const sync = useMutation({
    mutationFn: () => jiraApi.sync(entityType, entityId),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['jira-references'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not sync with Jira.');
    },
  });

  return (
    <div className="jira-sync">
      {reference !== undefined &&
        (reference.externalUrl === null ? (
          <code>{reference.externalKey ?? reference.externalId}</code>
        ) : (
          <a href={reference.externalUrl} target="_blank" rel="noreferrer">
            <code>{reference.externalKey ?? reference.externalId}</code>
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
        {reference === undefined ? 'Sync to Jira' : 'Re-sync'}
      </Button>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
