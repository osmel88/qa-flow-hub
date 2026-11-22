import { DEFECT_SEVERITIES, DEFECT_STATUSES, PRIORITIES } from '@qa-flow-hub/shared';
import type {
  CustomFieldView,
  DefectView,
  ExternalReferenceView,
  WorkflowTransition,
} from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextAreaField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { defectWorkflowApi, defectsApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { AttachmentsPanel } from '../components/AttachmentsPanel';
import { JiraSyncCell, useJiraReferences } from '../components/JiraSyncCell';
import { PageHeader } from '../components/PageHeader';
import {
  CustomFieldInputs,
  CustomFieldSummary,
  draftForCreate,
  useCustomFields,
} from '../components/CustomFieldInputs';
import type { CustomFieldDraft } from '../components/CustomFieldInputs';
import { humanize, toneFor } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';

export function DefectsPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('major');
  const [error, setError] = useState<string | null>(null);
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState<CustomFieldDraft>({});
  const customFields = useCustomFields(activeProjectId, 'defect');
  const workflow = useQuery({
    queryKey: ['defect-workflow', activeProjectId],
    queryFn: () => defectWorkflowApi.get(activeProjectId ?? ''),
    enabled: activeProjectId !== null,
  });

  const list = useQuery({
    queryKey: ['defects', activeProjectId, status],
    queryFn: () =>
      defectsApi.list({
        projectId: activeProjectId ?? '',
        ...(status === '' ? {} : { status }),
      }),
    enabled: activeProjectId !== null,
  });
  const jiraReferences = useJiraReferences(activeProjectId ?? '', 'defect');

  const create = useMutation({
    mutationFn: () =>
      defectsApi.create({
        projectId: activeProjectId ?? '',
        title,
        description: description === '' ? null : description,
        severity: severity as 'major',
        priority: 'medium',
        requirementIds: [],
        customFields: draftForCreate(customDraft),
      }),
    onSuccess: async () => {
      setCustomDraft({});
      setTitle('');
      setDescription('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['defects'] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('defects.couldNotCreateTheDefect'));
    },
  });

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      defectsApi.changeStatus(input.id, input.status),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['defects'] });
    },
    onError: (cause) => {
      // The menu offers the project's workflow, but the API decides: the
      // workflow may have changed, or the move may need a field or a role.
      setError(cause instanceof ApiError ? cause.message : t('defects.couldNotChangeTheStatus'));
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <>
      <PageHeader
        title={t('defects.defects')}
        description={t('defects.defectsRaisedFromAFailed')}
      />

      <section className="card" aria-labelledby="new-defect">
        <h2 id="new-defect">{t('defects.reportADefect')}</h2>
        {error !== null && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
        <TextField
          label={t('defects.title')}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        <TextAreaField
          label={t('defects.description')}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
        <SelectField
          label={t('defects.severity')}
          hint={t('defects.severityIsHowBadlyIt')}
          options={DEFECT_SEVERITIES.map((value) => ({ value, label: humanize(value) }))}
          value={severity}
          onChange={(event) => {
            setSeverity(event.target.value);
          }}
        />
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
          {t('defects.reportDefect')}
        </Button>
      </section>

      <section className="card filters" aria-label={t('defects.filters')}>
        <SelectField
          label={t('defects.status')}
          options={[
            { value: '', label: t('defects.anyStatus') },
            ...DEFECT_STATUSES.map((value) => ({ value, label: humanize(value) })),
          ]}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
          }}
        />
      </section>

      <DataState
        isPending={list.isPending}
        error={list.error}
        isEmpty={(list.data?.data.length ?? 0) === 0}
        emptyMessage={t('defects.noDefectMatchesTheseFilters')}
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">{t('defects.key')}</th>
              <th scope="col">{t('defects.title')}</th>
              <th scope="col">{t('defects.severity')}</th>
              <th scope="col">{t('defects.status')}</th>
              <th scope="col">{t('defects.origin')}</th>
              <th scope="col">{t('defects.moveTo')}</th>
              <th scope="col">{t('defects.jira')}</th>
              <th scope="col">{t('defects.evidence')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.data.map((defect) => (
              <DefectRow
                key={defect.id}
                defect={defect}
                evidenceOpen={evidenceFor === defect.id}
                onToggleEvidence={() => {
                  setEvidenceFor(evidenceFor === defect.id ? null : defect.id);
                }}
                onChangeStatus={(value) => {
                  changeStatus.mutate({ id: defect.id, status: value });
                }}
                jiraReference={jiraReferences.data?.get(defect.id)}
                transitions={workflow.data?.transitions}
                customFields={customFields}
              />
            ))}
          </tbody>
        </table>
      </DataState>
    </>
  );
}

interface DefectRowProps {
  defect: DefectView;
  evidenceOpen: boolean;
  onToggleEvidence: () => void;
  onChangeStatus: (status: string) => void;
  jiraReference: ExternalReferenceView | undefined;
  transitions: WorkflowTransition[] | undefined;
  customFields: CustomFieldView[];
}

function DefectRow({
  defect,
  evidenceOpen,
  onToggleEvidence,
  onChangeStatus,
  jiraReference,
  transitions,
  customFields,
}: DefectRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const targets =
    transitions === undefined
      ? DEFECT_STATUSES.filter((value) => value !== defect.status)
      : transitions.filter((item) => item.from === defect.status).map((item) => item.to);
  return (
    <>
      <tr>
        <td>
          <code>{defect.key}</code>
        </td>
        <td>
          {defect.title}
          <br />
          <CustomFieldSummary fields={customFields} values={defect.customFields} />
        </td>
        <td>
          <Badge tone={toneFor(defect.severity)}>{humanize(defect.severity)}</Badge>
        </td>
        <td>
          <Badge tone={toneFor(defect.status)}>{humanize(defect.status)}</Badge>
        </td>
        <td className="muted">
          {defect.testResultId === null
            ? t('defects.reportedManually')
            : t('defects.fromATestResult')}
        </td>
        <td>
          <select
            className="ui-input"
            aria-label={t('defects.changeStatusOf', { key: defect.key })}
            value=""
            onChange={(event) => {
              onChangeStatus(event.target.value);
            }}
          >
            <option value="">{t('defects.choose')}</option>
            {targets.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </td>
        <td>
          <JiraSyncCell entityType="defect" entityId={defect.id} reference={jiraReference} />
        </td>
        <td>
          <Button size="sm" variant="ghost" aria-expanded={evidenceOpen} onClick={onToggleEvidence}>
            {evidenceOpen ? t('defects.hideEvidence') : t('defects.evidence')}
          </Button>{' '}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={editing}
            onClick={() => {
              setEditing(!editing);
            }}
          >
            {t('defects.edit')}
          </Button>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={8}>
            <EditDefect
              defect={defect}
              onDone={() => {
                setEditing(false);
              }}
            />
          </td>
        </tr>
      )}
      {evidenceOpen && (
        <tr>
          <td colSpan={8}>
            <AttachmentsPanel
              entityType="defect"
              entityId={defect.id}
              title={t('defects.evidenceFor', { key: defect.key })}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Edits the descriptive fields; the status keeps its own workflow menu, and a
 * defect is never deleted from the UI so metrics keep every defect found.
 */
export function EditDefect({
  defect,
  onDone,
}: {
  defect: DefectView;
  onDone: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(defect.title);
  const [description, setDescription] = useState(defect.description ?? '');
  const [severity, setSeverity] = useState<string>(defect.severity);
  const [priority, setPriority] = useState<string>(defect.priority);
  const [error, setError] = useState<string | null>(null);
  const titleError = title.trim().length < 3 ? t('defects.titleMustHaveAtLeast3') : undefined;

  const save = useMutation({
    mutationFn: () =>
      defectsApi.update(defect.id, {
        title: title.trim(),
        description: description.trim() === '' ? null : description.trim(),
        severity: severity as DefectView['severity'],
        priority: priority as (typeof PRIORITIES)[number],
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['defects'] });
      onDone();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('defects.couldNotSaveTheDefect'));
    },
  });

  return (
    <form
      aria-label={t('defects.editDefect', { key: defect.key })}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      <TextField
        label={t('defects.title')}
        value={title}
        error={titleError}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <TextAreaField
        label={t('defects.description')}
        value={description}
        onChange={(event) => {
          setDescription(event.target.value);
        }}
      />
      <SelectField
        label={t('defects.severity')}
        options={DEFECT_SEVERITIES.map((value) => ({ value, label: humanize(value) }))}
        value={severity}
        onChange={(event) => {
          setSeverity(event.target.value);
        }}
      />
      <SelectField
        label={t('defects.priority')}
        options={PRIORITIES.map((value) => ({ value, label: humanize(value) }))}
        value={priority}
        onChange={(event) => {
          setPriority(event.target.value);
        }}
      />
      <div className="actions">
        <Button type="submit" loading={save.isPending} disabled={titleError !== undefined}>
          {t('defects.save')}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          {t('defects.cancel')}
        </Button>
      </div>
    </form>
  );
}
