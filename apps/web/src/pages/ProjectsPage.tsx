import { createProjectSchema, projectKeySchema, updateProjectSchema } from '@qa-flow-hub/shared';
import type { OrganizationSummary, ProjectView } from '@qa-flow-hub/shared';
import { Badge, Button, DataState, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { useProject } from '../project/project-context';
import { useProjectPermissions } from '../components/use-project-permissions';
import { projectsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PlanLimitAlert } from '../components/PlanLimitAlert';
import { PageHeader } from '../components/PageHeader';
import { humanize, toneFor } from '../components/status';
import { t } from '../i18n/i18n';

/**
 * The API's own schema decides, so the form and the server cannot disagree.
 * Whitespace is refused here even though the schema trims it: the rule says
 * letters and digits, and a key typed with a space is a typo.
 */
export function projectKeyError(key: string): string | undefined {
  if (key === '') return undefined;
  return /\s/.test(key) || !projectKeySchema.safeParse(key).success
    ? t('projects.keyRule')
    : undefined;
}

export function projectNameError(name: string): string | undefined {
  if (name === '') return undefined;
  return createProjectSchema.shape.name.safeParse(name).success
    ? undefined
    : t('validation.projectName');
}

/**
 * The session carries `capabilities.createProjects`, derived by the API from
 * the same rule its guard enforces. When it is missing (a session stored by an
 * older client) the form stays enabled and the API decides.
 */
export function canCreateProjects(organization: OrganizationSummary | null | undefined): boolean {
  if (organization === null || organization === undefined) return false;
  return organization.capabilities?.createProjects ?? true;
}

export function ProjectsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { activeOrganization } = useAuth();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const allowed = canCreateProjects(activeOrganization);

  const {
    data,
    isPending,
    error: loadError,
  } = useQuery({
    queryKey: ['projects-page'],
    queryFn: () => projectsApi.list(),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['projects-page'] });
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    await queryClient.invalidateQueries({ queryKey: ['billing'] });
  };

  const keyError = projectKeyError(key);
  const nameError = projectNameError(name);
  const canCreate =
    allowed && name !== '' && key !== '' && keyError === undefined && nameError === undefined;

  const create = useMutation({
    mutationFn: () => projectsApi.create({ name: name.trim(), key }),
    onSuccess: async () => {
      setName('');
      setKey('');
      setError(null);
      await invalidate();
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError && cause.code === 'FORBIDDEN'
          ? t('projects.roleCannotCreate')
          : cause instanceof ApiError
            ? cause.message
            : t('projects.couldNotCreateTheProject'),
      );
    },
  });

  return (
    <>
      <PageHeader title={t('projects.projects')} description={t('projects.aProjectOwnsItsOwn')} />

      <section className="card" aria-labelledby="new-project">
        <h2 id="new-project">{t('projects.newProject')}</h2>
        {!allowed && (
          <p className="ui-state" role="note">
            {t('projects.roleCannotCreate')}
          </p>
        )}
        {create.error instanceof ApiError && create.error.code === 'PLAN_LIMIT_REACHED' ? (
          <PlanLimitAlert error={create.error} />
        ) : (
          error !== null && (
            <p className="ui-field__error" role="alert">
              {error}
            </p>
          )
        )}
        <div className="grid-2">
          <TextField
            label={t('projects.name')}
            value={name}
            error={nameError}
            disabled={!allowed}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <TextField
            label={t('projects.key')}
            hint={t('projects.itPrefixesEveryReadableId', { rule: t('projects.keyRule') })}
            value={key}
            error={keyError}
            disabled={!allowed}
            onChange={(event) => {
              setKey(event.target.value.toUpperCase());
            }}
          />
        </div>
        <Button
          loading={create.isPending}
          disabled={!canCreate}
          onClick={() => {
            create.mutate();
          }}
        >
          {t('projects.createProject')}
        </Button>
      </section>

      <p className="muted">{t('projects.noDeleteExplanation')}</p>

      <DataState
        isPending={isPending}
        error={loadError}
        isEmpty={(data?.data.length ?? 0) === 0}
        emptyMessage={t('projects.noProjectsYetCreateThe')}
      >
        <table className="table card">
          <caption className="visually-hidden">{t('projects.projectsInThisOrganization')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('projects.key')}</th>
              <th scope="col">{t('projects.name')}</th>
              <th scope="col">{t('projects.status')}</th>
              <th scope="col">{t('projects.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((project) => (
              <ProjectRow key={project.id} project={project} onChanged={invalidate} />
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}

/**
 * One project and what the caller may do with it. Editing, archiving and
 * restoring need `project.manage` in that project; anyone who sees the
 * project can open it. There is no delete: archiving keeps the history.
 */
function ProjectRow({
  project,
  onChanged,
}: {
  project: ProjectView;
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { selectProject } = useProject();
  const { can } = useProjectPermissions(project.id);
  const manage = can('project.manage');
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const archived = project.status === 'archived';

  const fail = (cause: unknown, fallback: string) => {
    setError(cause instanceof ApiError ? cause.message : fallback);
  };

  const update = useMutation({
    mutationFn: () =>
      projectsApi.update(project.id, {
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
      }),
    onSuccess: async () => {
      setError(null);
      setEditing(false);
      await onChanged();
    },
    onError: (cause) => fail(cause, t('projects.couldNotSaveTheProject')),
  });

  const toggleArchive = useMutation({
    mutationFn: () =>
      archived ? projectsApi.restore(project.id) : projectsApi.archive(project.id),
    onSuccess: async () => {
      setError(null);
      setConfirmArchive(false);
      await onChanged();
    },
    onError: (cause) => fail(cause, t('projects.couldNotChangeTheProject')),
  });

  const editValid = updateProjectSchema.safeParse({
    name: name.trim(),
    description: description.trim() === '' ? null : description.trim(),
  }).success;

  return (
    <tr>
      <td>
        <code>{project.key}</code>
      </td>
      <td>
        {editing ? (
          <div>
            <TextField
              label={t('projects.name')}
              value={name}
              error={projectNameError(name)}
              onChange={(event) => setName(event.target.value)}
            />
            <TextAreaField
              label={t('projects.description')}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        ) : (
          <>
            {project.name}
            {project.description !== null && <p className="muted">{project.description}</p>}
          </>
        )}
        {error !== null && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
      </td>
      <td>
        <Badge tone={toneFor(project.status)}>{humanize(project.status)}</Badge>
      </td>
      <td>
        <div className="row-actions">
          {editing ? (
            <>
              <Button
                size="sm"
                loading={update.isPending}
                disabled={!editValid}
                onClick={() => update.mutate()}
              >
                {t('projects.save')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setEditing(false);
                  setName(project.name);
                  setDescription(project.description ?? '');
                }}
              >
                {t('projects.cancel')}
              </Button>
            </>
          ) : confirmArchive ? (
            <>
              <span>{t('projects.confirmArchive', { key: project.key })}</span>
              <Button
                size="sm"
                variant="danger"
                loading={toggleArchive.isPending}
                onClick={() => toggleArchive.mutate()}
              >
                {t('projects.confirmArchiveButton')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmArchive(false)}>
                {t('projects.cancel')}
              </Button>
            </>
          ) : (
            <>
              {!archived && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t('projects.openProject', { key: project.key })}
                  onClick={() => {
                    selectProject(project.id);
                    void navigate('/dashboard');
                  }}
                >
                  {t('projects.open')}
                </Button>
              )}
              {manage && !archived && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t('projects.editProject', { key: project.key })}
                  onClick={() => setEditing(true)}
                >
                  {t('projects.edit')}
                </Button>
              )}
              {manage && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={archived && toggleArchive.isPending}
                  onClick={() => (archived ? toggleArchive.mutate() : setConfirmArchive(true))}
                >
                  {archived ? t('projects.restore') : t('projects.archive')}
                </Button>
              )}
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
