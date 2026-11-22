import {
  PRIORITIES,
  REQUIREMENT_STATUSES,
  REQUIREMENT_TYPES,
  updateRequirementSchema,
} from '@qa-flow-hub/shared';
import type { RequirementView } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
            {requirement.data.acceptanceCriteria !== null && (
              <>
                <h3>{t('requirementDetail.acceptanceCriteria')}</h3>
                <p>{requirement.data.acceptanceCriteria}</p>
              </>
            )}
          </section>
          <ManageRequirement requirement={requirement.data} />
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

const choices = (values: readonly string[]) =>
  values.map((value) => ({ value, label: humanize(value) }));

/**
 * Edit, status and delete. Editing appends a version; the status follows the
 * API's transition table, so an illegal move is reported, not hidden. Delete
 * is a soft delete: the row and its history stay, its coverage links go.
 */
function ManageRequirement({ requirement }: { requirement: RequirementView }): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { can } = useProjectPermissions(requirement.projectId);
  const writable = can('requirements.write');
  const manageable = can('requirements.manage');
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [title, setTitle] = useState(requirement.title);
  const [description, setDescription] = useState(requirement.description ?? '');
  const [criteria, setCriteria] = useState(requirement.acceptanceCriteria ?? '');
  const [type, setType] = useState<string>(requirement.type);
  const [priority, setPriority] = useState<string>(requirement.priority);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['requirement', requirement.id] });
    await queryClient.invalidateQueries({ queryKey: ['requirements'] });
  };
  const fail = (fallback: string) => (cause: unknown) =>
    setError(cause instanceof ApiError ? cause.message : fallback);

  const draft = {
    title: title.trim(),
    description: description.trim() === '' ? null : description.trim(),
    acceptanceCriteria: criteria.trim() === '' ? null : criteria.trim(),
    type: type as RequirementView['type'],
    priority: priority as RequirementView['priority'],
  };
  const valid = updateRequirementSchema.safeParse(draft).success;

  const save = useMutation({
    mutationFn: () => requirementsApi.update(requirement.id, draft),
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
    onError: fail(t('requirementDetail.couldNotSave')),
  });
  const changeStatus = useMutation({
    mutationFn: (status: string) => requirementsApi.changeStatus(requirement.id, status),
    onSuccess: refresh,
    onError: fail(t('requirementDetail.couldNotChangeTheStatus')),
  });
  const remove = useMutation({
    mutationFn: () => requirementsApi.remove(requirement.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['requirements'] });
      void navigate('/requirements');
    },
    onError: fail(t('requirementDetail.couldNotDelete')),
  });

  if (!writable && !manageable) return <></>;

  return (
    <section className="card" aria-labelledby="manage-requirement">
      <h2 id="manage-requirement">{t('requirementDetail.manage')}</h2>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {manageable && (
        <SelectField
          label={t('requirementDetail.changeStatus')}
          options={[
            { value: '', label: t('requirementDetail.chooseAStatus') },
            ...choices(REQUIREMENT_STATUSES.filter((value) => value !== requirement.status)),
          ]}
          value=""
          disabled={changeStatus.isPending}
          onChange={(event) => {
            if (event.target.value !== '') changeStatus.mutate(event.target.value);
          }}
        />
      )}
      {writable && editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save.mutate();
          }}
          noValidate
        >
          <TextField
            label={t('requirementDetail.title')}
            value={title}
            error={title.trim().length < 3 ? t('requirementDetail.titleTooShort') : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          <TextAreaField
            label={t('requirementDetail.description')}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <TextAreaField
            label={t('requirementDetail.acceptanceCriteria')}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
          />
          <div className="grid-2">
            <SelectField
              label={t('requirementDetail.type')}
              options={choices(REQUIREMENT_TYPES)}
              value={type}
              onChange={(event) => setType(event.target.value)}
            />
            <SelectField
              label={t('requirementDetail.priority')}
              options={choices(PRIORITIES)}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </div>
          <div className="row-actions">
            <Button type="submit" loading={save.isPending} disabled={!valid}>
              {t('requirementDetail.save')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
              {t('requirementDetail.cancel')}
            </Button>
          </div>
        </form>
      )}
      {writable && !editing && (
        <div className="row-actions">
          <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
            {t('requirementDetail.edit')}
          </Button>
          {confirmDelete ? (
            <>
              <span>{t('requirementDetail.confirmDelete', { key: requirement.key })}</span>
              <Button
                type="button"
                variant="danger"
                loading={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {t('requirementDetail.confirmDeleteButton')}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>
                {t('requirementDetail.cancel')}
              </Button>
            </>
          ) : (
            <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)}>
              {t('requirementDetail.delete')}
            </Button>
          )}
        </div>
      )}
      <p className="muted">{t('requirementDetail.deleteExplanation')}</p>
    </section>
  );
}
