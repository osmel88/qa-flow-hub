import { DEFECT_SEVERITIES, DEFECT_STATUSES } from '@qa-flow-hub/shared';
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
      setError(cause instanceof ApiError ? cause.message : 'Could not create the defect.');
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
      setError(cause instanceof ApiError ? cause.message : 'Could not change the status.');
    },
  });

  if (activeProjectId === null) {
    return <NoProject />;
  }

  return (
    <>
      <PageHeader
        title="Defects"
        description="Defects raised from a failed result keep a link back to the execution that found them."
      />

      <section className="card" aria-labelledby="new-defect">
        <h2 id="new-defect">Report a defect</h2>
        {error !== null && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
        <TextField
          label="Title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        <TextAreaField
          label="Description"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
        <SelectField
          label="Severity"
          hint="Severity is how badly it breaks; priority is when we will fix it. They are not the same field."
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
          Report defect
        </Button>
      </section>

      <section className="card filters" aria-label="Filters">
        <SelectField
          label="Status"
          options={[
            { value: '', label: 'Any status' },
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
        emptyMessage="No defect matches these filters."
      >
        <table className="table card">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Title</th>
              <th scope="col">Severity</th>
              <th scope="col">Status</th>
              <th scope="col">Origin</th>
              <th scope="col">Move to</th>
              <th scope="col">Jira</th>
              <th scope="col">Evidence</th>
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
          {defect.testResultId === null ? 'Reported manually' : 'From a test result'}
        </td>
        <td>
          <select
            className="ui-input"
            aria-label={`Change status of ${defect.key}`}
            value=""
            onChange={(event) => {
              onChangeStatus(event.target.value);
            }}
          >
            <option value="">Choose…</option>
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
            {evidenceOpen ? 'Hide evidence' : 'Evidence'}
          </Button>
        </td>
      </tr>
      {evidenceOpen && (
        <tr>
          <td colSpan={8}>
            <AttachmentsPanel
              entityType="defect"
              entityId={defect.id}
              title={`Evidence for ${defect.key}`}
            />
          </td>
        </tr>
      )}
    </>
  );
}
