import {
  IMPLEMENTATION_STATES,
  REQUIREMENT_STATUSES,
  REQUIREMENT_TYPES,
  PRIORITIES,
} from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { requirementsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { Link } from 'react-router-dom';
import { CoverageLinks } from '../components/CoverageLinks';
import { ImplementationBadge } from '../components/ImplementationBadge';
import { JiraSyncCell, useJiraReferences } from '../components/JiraSyncCell';
import { PageHeader } from '../components/PageHeader';
import {
  CustomFieldInputs,
  draftForCreate,
  useCustomFields,
} from '../components/CustomFieldInputs';
import type { CustomFieldDraft } from '../components/CustomFieldInputs';
import { humanize, toneFor } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';

const options = (values: readonly string[]) =>
  values.map((value) => ({ value, label: humanize(value) }));

export function RequirementsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [implementation, setImplementation] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<string>('functional');
  const [priority, setPriority] = useState<string>('medium');
  const [error, setError] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState<CustomFieldDraft>({});
  const customFields = useCustomFields(activeProjectId, 'requirement');
  // One requirement at a time: the panel is an editor, and two open at once
  // invites linking a case to the requirement the user was not looking at.
  const [coverageFor, setCoverageFor] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['requirements', activeProjectId, status, search, implementation],
    queryFn: () =>
      requirementsApi.list({
        projectId: activeProjectId ?? '',
        ...(status === '' ? {} : { status }),
        ...(search === '' ? {} : { search }),
        ...(implementation === '' ? {} : { implementation }),
      }),
    enabled: activeProjectId !== null,
  });
  const jiraReferences = useJiraReferences(activeProjectId ?? '', 'requirement');

  const create = useMutation({
    mutationFn: () =>
      requirementsApi.create({
        projectId: activeProjectId ?? '',
        title,
        description: description === '' ? null : description,
        type: type as 'functional',
        priority: priority as 'medium',
        tags: [],
        customFields: draftForCreate(customDraft),
      }),
    onSuccess: async () => {
      setCustomDraft({});
      setTitle('');
      setDescription('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['requirements'] });
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiError ? cause.message : t('requirements.couldNotCreateTheRequirement'),
      );
    },
  });

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      requirementsApi.changeStatus(input.id, input.status),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['requirements'] });
    },
    onError: (cause) => {
      // The API refuses illegal transitions; surfacing its message is more
      // useful than duplicating the state machine in the client.
      setError(
        cause instanceof ApiError ? cause.message : t('requirements.couldNotChangeTheStatus'),
      );
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <>
      <PageHeader
        title={t('requirements.requirements')}
        description={t('requirements.whatTheProductMustDo')}
      />

      <section className="card" aria-labelledby="new-requirement">
        <h2 id="new-requirement">{t('requirements.newRequirement')}</h2>
        {error !== null && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
        <TextField
          label={t('requirements.title')}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        <TextAreaField
          label={t('requirements.description')}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
        <div className="grid-2">
          <SelectField
            label={t('requirements.type')}
            options={options(REQUIREMENT_TYPES)}
            value={type}
            onChange={(event) => {
              setType(event.target.value);
            }}
          />
          <SelectField
            label={t('requirements.priority')}
            options={options(PRIORITIES)}
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value);
            }}
          />
        </div>
        <CustomFieldInputs
          fields={customFields}
          values={{}}
          draft={customDraft}
          onChange={setCustomDraft}
        />
        <Button
          loading={create.isPending}
          disabled={title.trim().length < 3}
          onClick={() => {
            create.mutate();
          }}
        >
          {t('requirements.createRequirement')}
        </Button>
      </section>

      <section className="card filters" aria-label={t('requirements.filters')}>
        <TextField
          label={t('requirements.search')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <SelectField
          label={t('requirements.status')}
          options={[
            { value: '', label: t('requirements.anyStatus') },
            ...options(REQUIREMENT_STATUSES),
          ]}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
          }}
        />
        <SelectField
          label={t('requirements.implementation')}
          options={[
            { value: '', label: t('requirements.anyImplementation') },
            ...options(IMPLEMENTATION_STATES),
          ]}
          value={implementation}
          onChange={(event) => {
            setImplementation(event.target.value);
          }}
        />
      </section>

      <DataState
        isPending={list.isPending}
        error={list.error}
        isEmpty={(list.data?.data.length ?? 0) === 0}
        emptyMessage={t('requirements.noRequirementMatchesTheseFilters')}
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">{t('requirements.key')}</th>
              <th scope="col">{t('requirements.title')}</th>
              <th scope="col">{t('requirements.priority')}</th>
              <th scope="col">{t('requirements.status')}</th>
              <th scope="col">{t('requirements.implementation')}</th>
              <th scope="col">{t('requirements.moveTo')}</th>
              <th scope="col">{t('requirements.coverage')}</th>
              <th scope="col">{t('requirements.jira')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.data.map((requirement) => (
              <Fragment key={requirement.id}>
                <tr>
                  <td>
                    <Link to={`/requirements/${requirement.id}`}>
                      <code>{requirement.key}</code>
                    </Link>
                  </td>
                  <td>
                    <Link to={`/requirements/${requirement.id}`}>{requirement.title}</Link>
                  </td>
                  <td>{humanize(requirement.priority)}</td>
                  <td>
                    <Badge tone={toneFor(requirement.status)}>{humanize(requirement.status)}</Badge>
                  </td>
                  <td>
                    <ImplementationBadge implementation={requirement.implementation} />
                  </td>
                  <td>
                    <select
                      className="ui-input"
                      aria-label={t('requirements.changeStatusOf', { key: requirement.key })}
                      value=""
                      onChange={(event) => {
                        changeStatus.mutate({ id: requirement.id, status: event.target.value });
                      }}
                    >
                      <option value="">{t('requirements.choose')}</option>
                      {REQUIREMENT_STATUSES.filter((value) => value !== requirement.status).map(
                        (value) => (
                          <option key={value} value={value}>
                            {humanize(value)}
                          </option>
                        ),
                      )}
                    </select>
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setCoverageFor((current) =>
                          current === requirement.id ? null : requirement.id,
                        );
                      }}
                    >
                      {coverageFor === requirement.id
                        ? t('requirements.hideTestCases')
                        : t('requirements.testCases')}
                    </Button>
                  </td>
                  <td>
                    <JiraSyncCell
                      entityType="requirement"
                      entityId={requirement.id}
                      reference={jiraReferences.data?.get(requirement.id)}
                    />
                  </td>
                </tr>
                {coverageFor === requirement.id && (
                  <tr>
                    <td colSpan={8}>
                      <CoverageLinks
                        side="requirement"
                        entityId={requirement.id}
                        projectId={activeProjectId}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}
