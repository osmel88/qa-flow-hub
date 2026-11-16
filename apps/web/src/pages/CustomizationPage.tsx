import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, DEFECT_STATUSES } from '@qa-flow-hub/shared';
import type {
  CustomFieldEntity,
  CustomFieldType,
  CustomFieldView,
  DefectStatus,
  WorkflowTransition,
  WorkflowTransitionPermission,
} from '@qa-flow-hub/shared';
import { Badge, Button, DataState, SelectField, TextField } from '@qa-flow-hub/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { customFieldsApi, defectWorkflowApi } from '../api/endpoints';
import { ApiError } from '../api/http-client';
import { PageHeader } from '../components/PageHeader';
import { humanize } from '../components/status';
import { useProject } from '../project/project-context';
import { NoProject } from './NoProject';
import { t } from '../i18n/i18n';

const ENTITY_LABELS: Record<CustomFieldEntity, string> = {
  get requirement() {
    return t('customization.requirements');
  },
  get test_case() {
    return t('customization.testCases');
  },
  get defect() {
    return t('customization.defects');
  },
};

function errorText(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) return fallback;
  return cause.message;
}

export function CustomizationPage(): React.JSX.Element {
  const { activeProjectId } = useProject();
  if (activeProjectId === null) {
    return <NoProject />;
  }
  return (
    <>
      <PageHeader
        title={t('customization.customization')}
        description={t('customization.fieldsThisProjectAddsTo')}
      />
      <CustomFieldsSection projectId={activeProjectId} />
      <WorkflowSection projectId={activeProjectId} />
    </>
  );
}

function CustomFieldsSection({ projectId }: { projectId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [entityType, setEntityType] = useState<CustomFieldEntity>('defect');
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fields = useQuery({
    queryKey: ['custom-fields', projectId, 'all'],
    queryFn: () => customFieldsApi.list(projectId, undefined, true),
  });
  const refresh = async (): Promise<void> => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['custom-fields'] });
  };

  const create = useMutation({
    mutationFn: () =>
      customFieldsApi.create({
        projectId,
        entityType,
        key,
        label,
        type,
        required,
        options:
          type === 'select' || type === 'multi_select'
            ? options
                .split(',')
                .map((option) => option.trim())
                .filter((option) => option !== '')
                .map((option) => ({ label: option }))
            : [],
      }),
    onSuccess: async () => {
      setKey('');
      setLabel('');
      setOptions('');
      setRequired(false);
      await refresh();
    },
    onError: (cause) => {
      setError(errorText(cause, t('customization.couldNotCreateTheField')));
    },
  });
  const toggle = useMutation({
    mutationFn: (field: CustomFieldView) =>
      field.archivedAt === null
        ? customFieldsApi.archive(field.id)
        : customFieldsApi.restore(field.id),
    onSuccess: refresh,
    onError: (cause) => {
      setError(errorText(cause, t('customization.couldNotChangeTheField')));
    },
  });

  const choice = type === 'select' || type === 'multi_select';

  return (
    <section className="card" aria-labelledby="custom-fields">
      <h2 id="custom-fields">{t('customization.customFields')}</h2>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      <div className="form-grid">
        <SelectField
          label={t('customization.entity')}
          options={CUSTOM_FIELD_ENTITIES.map((value) => ({ value, label: ENTITY_LABELS[value] }))}
          value={entityType}
          onChange={(event) => {
            setEntityType(event.target.value as CustomFieldEntity);
          }}
        />
        <TextField
          label={t('customization.key')}
          hint={t('customization.lowercaseLettersDigitsAndUnderscores')}
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
          }}
        />
        <TextField
          label={t('customization.label')}
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
        <SelectField
          label={t('customization.type')}
          options={CUSTOM_FIELD_TYPES.map((value) => ({ value, label: humanize(value) }))}
          value={type}
          onChange={(event) => {
            setType(event.target.value as CustomFieldType);
          }}
        />
        {choice && (
          <TextField
            label={t('customization.options')}
            hint={t('customization.commaSeparated')}
            value={options}
            onChange={(event) => {
              setOptions(event.target.value);
            }}
          />
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => {
              setRequired(event.target.checked);
            }}
          />
          {t('customization.required')}
        </label>
      </div>
      <Button
        loading={create.isPending}
        disabled={key.trim() === '' || label.trim() === '' || (choice && options.trim() === '')}
        onClick={() => {
          create.mutate();
        }}
      >
        {t('customization.addField')}
      </Button>

      <DataState
        isPending={fields.isPending}
        error={fields.error}
        isEmpty={fields.data?.length === 0}
        emptyMessage={t('customization.noCustomFieldsYet')}
      >
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('customization.entity')}</th>
              <th scope="col">{t('customization.key')}</th>
              <th scope="col">{t('customization.label')}</th>
              <th scope="col">{t('customization.type')}</th>
              <th scope="col">{t('customization.options')}</th>
              <th scope="col">{t('customization.state')}</th>
              <th scope="col">{t('customization.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {fields.data?.map((field) => (
              <tr key={field.id}>
                <td>{ENTITY_LABELS[field.entityType]}</td>
                <td>
                  <code>{field.key}</code>
                </td>
                <td>
                  {field.label}
                  {field.required ? ' *' : ''}
                </td>
                <td>{humanize(field.type)}</td>
                <td className="muted">
                  {field.options
                    .map((option) =>
                      option.archived
                        ? t('customization.archived', { label: option.label })
                        : option.label,
                    )
                    .join(', ')}
                </td>
                <td>
                  <Badge tone={field.archivedAt === null ? 'success' : 'neutral'}>
                    {field.archivedAt === null
                      ? t('customization.active')
                      : t('customization.archived2')}
                  </Badge>
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      toggle.mutate(field);
                    }}
                  >
                    {field.archivedAt === null
                      ? t('customization.archive', { key: field.key })
                      : t('customization.restore', { key: field.key })}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </section>
  );
}

function WorkflowSection({ projectId }: { projectId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<WorkflowTransition[]>([]);
  const [from, setFrom] = useState<DefectStatus>('open');
  const [to, setTo] = useState<DefectStatus>('closed');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const workflow = useQuery({
    queryKey: ['defect-workflow', projectId],
    queryFn: () => defectWorkflowApi.get(projectId),
  });
  const defectFields = useQuery({
    queryKey: ['custom-fields', projectId, 'defect'],
    queryFn: () => customFieldsApi.list(projectId, 'defect'),
  });
  useEffect(() => {
    if (workflow.data !== undefined) setDraft(workflow.data.transitions);
  }, [workflow.data]);

  const save = useMutation({
    mutationFn: () =>
      defectWorkflowApi.update({
        projectId,
        version: workflow.data?.version ?? 0,
        transitions: draft,
      }),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['defect-workflow'] });
    },
    onError: (cause) => {
      setSaved(false);
      setError(errorText(cause, t('customization.couldNotSaveTheWorkflow')));
    },
  });

  const change = (index: number, patch: Partial<WorkflowTransition>): void => {
    setSaved(false);
    setDraft((current) =>
      current.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
  };
  const statusOptions = DEFECT_STATUSES.map((value) => ({ value, label: humanize(value) }));

  return (
    <section className="card" aria-labelledby="defect-workflow">
      <h2 id="defect-workflow">{t('customization.defectWorkflow')}</h2>
      <p className="muted">
        {workflow.data?.customized === true
          ? t('customization.customizedVersion', { version: workflow.data.version })
          : t('customization.builtInWorkflowSavingCreates')}{' '}
        {t('customization.everyStatusMustStillBe')}
      </p>
      {error !== null && (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">{t('customization.workflowSaved')}</p>}
      <DataState isPending={workflow.isPending} error={workflow.error}>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('customization.from')}</th>
              <th scope="col">{t('customization.to')}</th>
              <th scope="col">{t('customization.who')}</th>
              <th scope="col">{t('customization.fieldsRequired')}</th>
              <th scope="col">{t('customization.remove')}</th>
            </tr>
          </thead>
          <tbody>
            {draft.map((transition, index) => (
              <tr key={`${transition.from}-${transition.to}`}>
                <td>{humanize(transition.from)}</td>
                <td>{humanize(transition.to)}</td>
                <td>
                  <select
                    className="ui-input"
                    aria-label={t('customization.whoMayMoveTo', {
                      from: transition.from,
                      to: transition.to,
                    })}
                    value={transition.permission}
                    onChange={(event) => {
                      change(index, {
                        permission: event.target.value as WorkflowTransitionPermission,
                      });
                    }}
                  >
                    <option value="defects.create">
                      {t('customization.anyoneWhoReportsDefects')}
                    </option>
                    <option value="defects.manage">{t('customization.defectManagersOnly')}</option>
                  </select>
                </td>
                <td>
                  <select
                    className="ui-input"
                    multiple
                    aria-label={t('customization.fieldsRequiredToMoveTo', {
                      from: transition.from,
                      to: transition.to,
                    })}
                    value={transition.requiredFieldIds}
                    onChange={(event) => {
                      change(index, {
                        requiredFieldIds: [...event.target.selectedOptions].map(
                          (option) => option.value,
                        ),
                      });
                    }}
                  >
                    {(defectFields.data ?? []).map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSaved(false);
                      setDraft((current) => current.filter((_, position) => position !== index));
                    }}
                  >
                    {t('customization.remove')} {transition.from} {t('customization.to2')}{' '}
                    {transition.to}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
      <div className="form-grid">
        <SelectField
          label={t('customization.newTransitionFrom')}
          options={statusOptions}
          value={from}
          onChange={(event) => {
            setFrom(event.target.value as DefectStatus);
          }}
        />
        <SelectField
          label={t('customization.newTransitionTo')}
          options={statusOptions}
          value={to}
          onChange={(event) => {
            setTo(event.target.value as DefectStatus);
          }}
        />
      </div>
      <div className="row-actions">
        <Button
          variant="secondary"
          disabled={from === to || draft.some((item) => item.from === from && item.to === to)}
          onClick={() => {
            setSaved(false);
            setDraft((current) => [
              ...current,
              { from, to, permission: 'defects.create', requiredFieldIds: [] },
            ]);
          }}
        >
          {t('customization.addTransition')}
        </Button>
        <Button
          loading={save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {t('customization.saveWorkflow')}
        </Button>
      </div>
    </section>
  );
}
