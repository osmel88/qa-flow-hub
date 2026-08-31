import { Badge, Button, DataState, SelectField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { requirementsApi, testDesignApi, traceabilityApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';

/**
 * Coverage editing, from either end of the same link.
 *
 * A requirement-to-case link is written as `requirement --verifies--> case`
 * because that is the direction the matrix reads; the panel exists on both
 * screens so a tester can start from whichever entity is in front of them, but
 * it writes the same row either way — two shapes for one fact would make the
 * matrix depend on where the user clicked.
 */
export function CoverageLinks({
  side,
  entityId,
  projectId,
}: {
  side: 'requirement' | 'test_case';
  entityId: string;
  projectId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const links = useQuery({
    queryKey: ['links', side, entityId],
    queryFn: () => traceabilityApi.links(side, entityId),
  });

  const cases = useQuery({
    queryKey: ['cases', projectId, null],
    queryFn: () => testDesignApi.cases({ projectId }),
    enabled: side === 'requirement',
  });

  const requirements = useQuery({
    queryKey: ['requirements', projectId, '', ''],
    queryFn: () => requirementsApi.list({ projectId }),
    enabled: side === 'test_case',
  });

  const counterparts =
    side === 'requirement'
      ? (cases.data?.data ?? []).map((testCase) => ({
          id: testCase.id,
          label: `${testCase.key} — ${testCase.title}`,
        }))
      : (requirements.data?.data ?? []).map((requirement) => ({
          id: requirement.id,
          label: `${requirement.key} — ${requirement.title}`,
        }));

  // Only requirement-to-case links belong here. A link of any other shape
  // touching this entity is somebody else's screen, and hiding it is better
  // than offering an Unlink button whose effect is not explained here.
  const relevant = (links.data ?? []).filter(
    (link) =>
      link.sourceType === 'requirement' &&
      link.targetType === 'test_case' &&
      (side === 'requirement' ? link.sourceId === entityId : link.targetId === entityId),
  );

  const linkedIds = new Set(
    relevant.map((link) => (side === 'requirement' ? link.targetId : link.sourceId)),
  );
  const labelById = new Map(counterparts.map((item) => [item.id, item.label]));

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['links'] }),
      // The matrix is a different query on a different screen; without this it
      // keeps reporting the coverage the user just changed.
      queryClient.invalidateQueries({ queryKey: ['matrix'] }),
    ]);
  };

  const link = useMutation({
    mutationFn: (counterpartId: string) =>
      traceabilityApi.link({
        sourceType: 'requirement',
        sourceId: side === 'requirement' ? entityId : counterpartId,
        targetType: 'test_case',
        targetId: side === 'requirement' ? counterpartId : entityId,
        linkType: 'verifies',
      }),
    onSuccess: async () => {
      setChoice('');
      setError(null);
      await refresh();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the link.');
    },
  });

  const unlink = useMutation({
    mutationFn: (id: string) => traceabilityApi.unlink(id),
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not remove the link.');
    },
  });

  const available = counterparts.filter((item) => !linkedIds.has(item.id));

  return (
    <section className="card" aria-label="Traceability links">
      <h3>{side === 'requirement' ? 'Verified by' : 'Verifies'}</h3>

      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}

      <DataState
        isPending={links.isPending}
        error={links.error}
        isEmpty={relevant.length === 0}
        emptyMessage={
          side === 'requirement'
            ? 'No test case verifies this requirement yet.'
            : 'This case is not linked to any requirement yet.'
        }
      >
        <ul className="plain-list">
          {relevant.map((traceLink) => {
            const counterpartId = side === 'requirement' ? traceLink.targetId : traceLink.sourceId;
            return (
              <li key={traceLink.id} className="row-actions">
                <span>{labelById.get(counterpartId) ?? counterpartId}</span>
                <Badge tone="neutral">{traceLink.linkType}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={unlink.isPending && unlink.variables === traceLink.id}
                  onClick={() => {
                    unlink.mutate(traceLink.id);
                  }}
                >
                  Unlink
                </Button>
              </li>
            );
          })}
        </ul>
      </DataState>

      <div className="row-actions">
        <SelectField
          label={side === 'requirement' ? 'Link a test case' : 'Link a requirement'}
          options={[
            { value: '', label: 'Choose…' },
            ...available.map((item) => ({ value: item.id, label: item.label })),
          ]}
          value={choice}
          onChange={(event) => {
            setChoice(event.target.value);
          }}
        />
        <Button
          size="sm"
          disabled={choice === ''}
          loading={link.isPending}
          onClick={() => {
            link.mutate(choice);
          }}
        >
          Link
        </Button>
      </div>
    </section>
  );
}
