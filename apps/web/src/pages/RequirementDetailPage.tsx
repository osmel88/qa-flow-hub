import { Badge, Button, DataState, SelectField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { requirementsApi, workItemsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { ImplementationBadge } from '../components/ImplementationBadge';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { useProjectPermissions } from '../components/use-project-permissions';
import { WORK_ITEM_TONE } from './WorkItemsPage';
import { t } from '../i18n/i18n';

/** A requirement and the work items that implement it (S4-F4). */
export function RequirementDetailPage(): React.JSX.Element {
  const { requirementId = '' } = useParams();
  const requirement = useQuery({
    queryKey: ['requirement', requirementId],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: () => requirementsApi.get(requirementId),
  });

  return (
    <DataState isPending={requirement.isPending} error={requirement.error} isEmpty={false}>
      {requirement.data !== undefined && (
        <>
          <PageHeader
            title={`${requirement.data.key} · ${requirement.data.title}`}
            description={t('requirementDetail.requirementDetailAndTheWork')}
          />
          <p>
            <Link to="/requirements">{t('requirementDetail.allRequirements')}</Link>
          </p>
          <section className="card" aria-labelledby="requirement-summary">
            <h2 id="requirement-summary">{t('requirementDetail.summary')}</h2>
            <p>
              <Badge tone={toneFor(requirement.data.status)}>
                {humanize(requirement.data.status)}
              </Badge>{' '}
              <Badge>{humanize(requirement.data.priority)}</Badge>{' '}
              <ImplementationBadge implementation={requirement.data.implementation} />
            </p>
            {requirement.data.description !== null && <p>{requirement.data.description}</p>}
          </section>
          <ImplementingWorkItems
            requirementId={requirement.data.id}
            projectId={requirement.data.projectId}
          />
        </>
      )}
    </DataState>
  );
}

function ImplementingWorkItems({
  requirementId,
  projectId,
}: {
  requirementId: string;
  projectId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { can } = useProjectPermissions(projectId);
  const editable = can('work_items.write');
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const links = useQuery({
    queryKey: ['requirement-work-items', requirementId],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: () => requirementsApi.workItems(requirementId),
  });
  const candidates = useQuery({
    queryKey: ['work-items', projectId, 'link-candidates'],
    queryFn: () => workItemsApi.list({ projectId }),
    enabled: editable,
  });
  const refresh = async () => {
    setError(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['requirement-work-items', requirementId] }),
      queryClient.invalidateQueries({ queryKey: ['requirement', requirementId] }),
      queryClient.invalidateQueries({ queryKey: ['requirements'] }),
    ]);
  };
  const onError = (cause: unknown) => {
    setError(
      cause instanceof ApiError ? cause.message : t('requirementDetail.couldNotUpdateTheLink'),
    );
  };
  const link = useMutation({
    mutationFn: (workItemId: string) => requirementsApi.linkWorkItem(requirementId, workItemId),
    onSuccess: async () => {
      setChoice('');
      await refresh();
    },
    onError,
  });
  const unlink = useMutation({
    mutationFn: (workItemId: string) => requirementsApi.unlinkWorkItem(requirementId, workItemId),
    onSuccess: refresh,
    onError,
  });
  const linked = new Set(links.data?.workItems.map((item) => item.workItemId) ?? []);
  const options = (candidates.data?.data ?? []).filter((item) => !linked.has(item.id));

  return (
    <section className="card" aria-labelledby="requirement-work-items">
      <h2 id="requirement-work-items">{t('requirementDetail.implementedBy')}</h2>
      {links.data !== undefined && (
        <p>
          <ImplementationBadge implementation={links.data.implementation} />
          {links.data.implementation.progress !== null &&
            ` ${links.data.implementation.progress}% done`}
        </p>
      )}
      <DataState
        isPending={links.isPending}
        error={links.error}
        isEmpty={(links.data?.workItems.length ?? 0) === 0}
        emptyMessage={t('requirementDetail.noWorkItemImplementsThis')}
      >
        <ul className="link-list">
          {links.data?.workItems.map((item) => (
            <li key={item.linkId}>
              <Link to={`/work-items/${item.workItemId}`}>
                <code>{item.key}</code> {item.title}
              </Link>{' '}
              <Badge tone={WORK_ITEM_TONE[item.status]}>{humanize(item.status)}</Badge>{' '}
              {editable && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t('requirementDetail.unlink', { key: item.key })}
                  onClick={() => {
                    unlink.mutate(item.workItemId);
                  }}
                >
                  {t('requirementDetail.unlink2')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DataState>
      {editable && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (choice !== '') {
              link.mutate(choice);
            }
          }}
        >
          <SelectField
            label={t('requirementDetail.linkWorkItem')}
            value={choice}
            options={[
              { value: '', label: t('requirementDetail.chooseAWorkItem') },
              ...options.map((item) => ({ value: item.id, label: `${item.key} · ${item.title}` })),
            ]}
            onChange={(event) => {
              setChoice(event.target.value);
            }}
          />
          <Button type="submit" disabled={choice === '' || link.isPending}>
            {t('requirementDetail.link')}
          </Button>
        </form>
      )}
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
